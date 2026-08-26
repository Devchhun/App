// AI Connected Story Visualization -- shared types, hard limits, and the
// strict NarrativeGraph validator, importable from both the main process
// (which talks to the cloud provider and never trusts its output) and the
// renderer (which reviews/edits a validated graph before it ever touches
// the project).
//
// Architecture mirrors shared/localAi.ts's ScenePlan pattern exactly, one
// level up: instead of one flat list of scenes, the model is asked to
// produce a whole-story NarrativeGraph (entities + relations + story beats)
// BEFORE any template/scene is chosen -- see StoryBeat.recommendedVisualization,
// which names one of the six built "visualization family" templates (see
// shared/templates.ts) rather than a generic template id. A StoryBeat is NOT
// a Scene; it becomes one only when accepted in the Visual Plan and converted
// via renderer/src/story/storyBeatToScene.ts, the same "propose, review,
// convert on accept" shape scenePlanToScenes.ts already uses.
//
// Distinct from shared/localAi.ts's LOCAL_AI_IPC (local-only, Ollama) -- this
// feature is cloud-only (Anthropic, see app/main/ai/providers/
// StoryAnalysisProvider.ts) and reuses the existing consent-preview-then-
// confirm flow (CloudConsentModal.tsx / CloudRequestPreview from
// shared/suggestions.ts), never a persisted consent flag.
import { z } from 'zod'
import { TEMPLATE_ICON_IDS, type TemplateIconId } from './templates'
import type { ClaudeErrorKind } from './suggestions'

// ---- Visualization families -- these ARE TemplateId values (registered in
// shared/templates.ts), not a separate concept, so StoryBeat.
// recommendedVisualization maps 1:1 onto the real template registry. Kept as
// its own narrower literal union (rather than the full TemplateId union)
// because a story beat may only ever recommend one of these six built
// families -- never an unrelated general-purpose template. ----
export const VISUALIZATION_TYPE_VALUES = [
  'central-identity',
  'reality-vs-dream',
  'body-vs-avatar',
  'source-branch',
  'chapter-evidence',
  'final-summary'
] as const
export type VisualizationType = (typeof VISUALIZATION_TYPE_VALUES)[number]

// ---- Narrative graph data model (exact shapes from the spec) ----

export type NarrativeEntityType = 'character' | 'body' | 'artifact' | 'place' | 'event' | 'concept' | 'chapter' | 'relationship'

export const NARRATIVE_ENTITY_TYPE_VALUES: NarrativeEntityType[] = [
  'character',
  'body',
  'artifact',
  'place',
  'event',
  'concept',
  'chapter',
  'relationship'
]

export interface NarrativeEntity {
  id: string
  type: NarrativeEntityType
  canonicalName: string
  aliases: string[]
  description: string
  firstSegmentId: string
  color: string
  iconId?: TemplateIconId
  imageAssetId?: string
}

export type NarrativeRelationType =
  | 'same_identity'
  | 'created_from'
  | 'split_from'
  | 'transformed_into'
  | 'sent_to_past'
  | 'simulated'
  | 'caused'
  | 'misunderstood_as'
  | 'revived'
  | 'merged_back'

export const NARRATIVE_RELATION_TYPE_VALUES: NarrativeRelationType[] = [
  'same_identity',
  'created_from',
  'split_from',
  'transformed_into',
  'sent_to_past',
  'simulated',
  'caused',
  'misunderstood_as',
  'revived',
  'merged_back'
]

export interface NarrativeRelation {
  id: string
  fromEntityId: string
  toEntityId: string
  type: NarrativeRelationType
  label: string
  segmentIds: string[]
}

export const STORY_BEAT_IMPORTANCE_VALUES = ['supporting', 'important', 'critical'] as const
export type StoryBeatImportance = (typeof STORY_BEAT_IMPORTANCE_VALUES)[number]

export interface StoryBeat {
  id: string
  startTime: number
  endTime: number
  segmentIds: string[]
  title: string
  summary: string
  purpose: string
  entities: string[]
  relations: string[]
  evidence?: string[]
  recommendedVisualization: VisualizationType
  importance: StoryBeatImportance
}

export interface NarrativeGraph {
  entities: NarrativeEntity[]
  relations: NarrativeRelation[]
  beats: StoryBeat[]
  chronology: string[]
  centralQuestion: string
  finalConclusion: string
}

// ---- Entity Bible (Section 2) -- user-editable independently of the
// AI-generated graph; editing it never re-triggers AI generation. ----
export interface EntityBible {
  id: string
  mediaId: string
  entities: NarrativeEntity[]
  /** Entity ids the user has explicitly locked (Section 2: "Lock identity").
   * A locked entity's color/icon/imageAssetId is never overwritten by a
   * later "Analyze Full Story" re-run merging in a fresh AI-proposed entity
   * of the same id -- kept as a separate list rather than a field on
   * NarrativeEntity itself since the spec's NarrativeEntity shape is fixed
   * exactly as given. */
  lockedEntityIds: string[]
}

// ---- Visual Plan (Section 3) ----
export type VisualPlanItemStatus = 'proposed' | 'accepted' | 'rejected'

export interface VisualPlanItem {
  beat: StoryBeat
  status: VisualPlanItemStatus
  /** True once the user has hand-edited this beat; preserved during bulk regeneration. */
  edited: boolean
  locked: boolean
  /** Set once "Generate Accepted Graphics" has turned this item into a real
   * Scene (the id of that Scene) -- lets a second bulk-generate pass skip
   * items already inserted instead of duplicating them on the Timeline. The
   * Scene itself is the source of truth from that point on; removing/editing
   * it happens on the Timeline/Properties panel, not here. */
  generatedSceneId?: string
}

export interface VisualPlan {
  id: string
  mediaId: string
  narrativeGraphId: string
  items: VisualPlanItem[]
  createdAt: string
}

// ---- Visual continuity (Section 6/7) ----
export interface StoryVisualTheme {
  entityColors: Record<string, string>
  characterAssets: Record<string, string>
  lineStyle: string
  lineWidth: number
  glowIntensity: number
  backgroundMode: string
  animationIntensity: number
  khmerFont: string
  latinFont: string
}

export interface StorySceneGroup {
  id: string
  name: string
  narrativeGraphId: string
  sceneIds: string[]
  theme: StoryVisualTheme
  entityBibleId: string
  lockedContinuity: boolean
}

// ---- Hard limits (mirrors shared/localAi.ts's SCENE_PLAN_LIMITS -- a
// single source of truth used by both the strict zod validator below and
// the generation-time JSON schema) ----
export const STORY_LIMITS = {
  /** Characters of transcript text fed to the model for one whole-story
   * analysis request -- deliberately generous (a single bounded request must
   * see the ENTIRE transcript to understand the complete narrative; see the
   * plan's "one bounded cloud request per analysis" scope decision) but
   * still finite, rejecting pathologically large transcripts outright rather
   * than attempting complex multi-request stitching. */
  maxTranscriptChars: 60_000,
  /** A transcript with more segments than this is rejected outright before
   * analysis is attempted, mirroring SCENE_PLAN_LIMITS.maxSegmentCount. */
  maxSegmentCount: 1_200,
  maxEntities: 40,
  maxRelations: 60,
  maxBeats: 60,
  maxSceneDurationSeconds: 15,
  minSceneDurationSeconds: 2,
  // Whole-story synthesis with a large output budget genuinely takes longer
  // than a single-segment classification call, and live testing showed real
  // variance for the SAME 84-segment transcript across runs -- 150s one
  // time, still incomplete past 300s another time -- so this is
  // deliberately generous (a one-time, patience-tolerant operation) and far
  // above shared/localAi.ts's SCENE_PLAN_LIMITS.requestTimeoutMs (120s, a
  // lighter per-batch task) or AnthropicProvider.ts's classification
  // default (60s).
  requestTimeoutMs: 420_000,
  /** Raw model output is rejected without even attempting JSON.parse past
   * this many characters -- bounds worst-case memory regardless of what the
   * provider's own output cap is set to. */
  maxOutputChars: 400_000,
  maxCanonicalNameChars: 80,
  maxAliasesPerEntity: 10,
  maxAliasChars: 60,
  maxEntityDescriptionChars: 400,
  maxRelationLabelChars: 120,
  maxSegmentIdsPerRelation: 40,
  maxBeatTitleChars: 100,
  maxBeatSummaryChars: 500,
  maxBeatPurposeChars: 200,
  maxSegmentIdsPerBeat: 40,
  maxEntitiesPerBeat: 20,
  maxRelationsPerBeat: 20,
  maxEvidenceItemsPerBeat: 5,
  maxEvidenceChars: 200,
  // Both generous enough for a real, richly-detailed story (live testing
  // against an 84-segment transcript with multiple bodies/chapter citations
  // showed the model's own natural synthesis exceeding the previous 300/500
  // caps) while still bounding worst-case output.
  maxCentralQuestionChars: 600,
  maxFinalConclusionChars: 1500
} as const

const colorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'must be a hex color like #5b8cff')

/** Same narrow, defense-in-depth check as shared/localAi.ts's
 * hasUnsafeMarkup -- duplicated rather than imported cross-file, matching
 * this codebase's established convention of small deliberate duplication
 * over coupling two independent validators together. */
const UNSAFE_MARKUP_RE = /<\s*\/?\s*(script|iframe|object|embed|svg|style)\b|javascript:|data:text\/html/i

function hasUnsafeMarkup(text: string | undefined): boolean {
  return typeof text === 'string' && UNSAFE_MARKUP_RE.test(text)
}

/** `z.enum` wants a literal tuple; some of the app's real id lists are plain
 * `T[]` (e.g. TEMPLATE_ICON_IDS, extended over time) so validating against
 * them via `.refine` (not a duplicated literal list) means this validator
 * can never drift out of sync with what the app actually supports. */
function idFrom<T extends string>(values: readonly T[], label: string) {
  const set = new Set<string>(values)
  return z
    .string()
    .refine((v): v is T => set.has(v), { message: `unknown ${label}` })
    .transform((v) => v as T)
}

const narrativeEntitySchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: idFrom<NarrativeEntityType>(NARRATIVE_ENTITY_TYPE_VALUES, 'entity type'),
  canonicalName: z.string().trim().min(1).max(STORY_LIMITS.maxCanonicalNameChars),
  aliases: z.array(z.string().trim().min(1).max(STORY_LIMITS.maxAliasChars)).max(STORY_LIMITS.maxAliasesPerEntity),
  description: z.string().trim().max(STORY_LIMITS.maxEntityDescriptionChars),
  firstSegmentId: z.string().trim().min(1).max(80),
  color: colorSchema,
  iconId: idFrom<TemplateIconId>(TEMPLATE_ICON_IDS, 'icon id').optional(),
  imageAssetId: z.string().trim().min(1).max(200).optional()
})

const narrativeRelationSchema = z.object({
  id: z.string().trim().min(1).max(80),
  fromEntityId: z.string().trim().min(1).max(80),
  toEntityId: z.string().trim().min(1).max(80),
  type: idFrom<NarrativeRelationType>(NARRATIVE_RELATION_TYPE_VALUES, 'relation type'),
  label: z.string().trim().min(1).max(STORY_LIMITS.maxRelationLabelChars),
  segmentIds: z.array(z.string().trim().min(1).max(80)).max(STORY_LIMITS.maxSegmentIdsPerRelation)
})

const storyBeatSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    startTime: z.number().finite().min(0).max(86_400),
    endTime: z.number().finite().min(0).max(86_400),
    segmentIds: z.array(z.string().trim().min(1).max(80)).min(1).max(STORY_LIMITS.maxSegmentIdsPerBeat),
    title: z.string().trim().min(1).max(STORY_LIMITS.maxBeatTitleChars),
    summary: z.string().trim().min(1).max(STORY_LIMITS.maxBeatSummaryChars),
    purpose: z.string().trim().min(1).max(STORY_LIMITS.maxBeatPurposeChars),
    entities: z.array(z.string().trim().min(1).max(80)).max(STORY_LIMITS.maxEntitiesPerBeat),
    relations: z.array(z.string().trim().min(1).max(80)).max(STORY_LIMITS.maxRelationsPerBeat),
    evidence: z.array(z.string().trim().min(1).max(STORY_LIMITS.maxEvidenceChars)).max(STORY_LIMITS.maxEvidenceItemsPerBeat).optional(),
    recommendedVisualization: idFrom<VisualizationType>(VISUALIZATION_TYPE_VALUES, 'visualization type'),
    importance: idFrom<StoryBeatImportance>(STORY_BEAT_IMPORTANCE_VALUES, 'beat importance')
  })
  .refine((b) => b.endTime > b.startTime, { message: 'endTime must be after startTime', path: ['endTime'] })
  .refine(
    (b) => {
      const textFields = [b.title, b.summary, b.purpose, ...(b.evidence ?? [])]
      return !textFields.some(hasUnsafeMarkup)
    },
    { message: 'beat text contains disallowed HTML/script markup', path: ['summary'] }
  )

export type NarrativeEntityParsed = z.infer<typeof narrativeEntitySchema>
export type NarrativeRelationParsed = z.infer<typeof narrativeRelationSchema>
export type StoryBeatParsed = z.infer<typeof storyBeatSchema>

/** Bumped whenever this shape changes in a way that makes an old raw model
 * response (if ever cached) unsafe to reuse without re-validating. */
export const STORY_SCHEMA_VERSION = 1

/** Server-filled envelope around one whole-story NarrativeGraph -- mirrors
 * shared/localAi.ts's ScenePlan wrapping scenePlanSceneSchema scenes.
 * `id`/`mediaId`/`model`/`generatedAt` are never asked of the model. */
export interface StoryAnalysis {
  version: typeof STORY_SCHEMA_VERSION
  id: string
  mediaId: string
  model: string
  generatedAt: string
  graph: NarrativeGraph
}

/** One malformed/rejected entity, relation, or beat from an otherwise-usable
 * graph -- surfaced to the user rather than silently dropped, matching the
 * existing cloud path's `missingSegmentIds` transparency convention. */
export interface RejectedNarrativeItem {
  kind: 'entity' | 'relation' | 'beat'
  index: number
  reason: string
}

export interface NarrativeGraphValidationResult {
  ok: boolean
  graph: NarrativeGraph | null
  rejectedItems: RejectedNarrativeItem[]
  envelopeError: string | null
}

export interface NarrativeGraphValidationContext {
  /** Real TranscriptSegment ids for this media -- any entity/relation/beat
   * referencing an id outside this set is rejected individually rather than
   * trusted. */
  segmentIds: ReadonlySet<string>
  mediaDurationSeconds: number
}

/** The single validation entry point every raw model response must pass
 * through before it can influence the project in any way. Never throws --
 * always returns a result, even for input that isn't valid JSON at all.
 * Cross-references are checked in dependency order: entities first, then
 * relations (which may only reference valid entities), then beats (which
 * may only reference valid entities/relations), then chronology/top-level
 * fields -- an item referencing something already dropped is dropped too,
 * never trusted on the model's say-so alone. */
export function validateNarrativeGraph(raw: unknown, context: NarrativeGraphValidationContext): NarrativeGraphValidationResult {
  const envelopeSchema = z.object({
    entities: z.array(z.unknown()).max(STORY_LIMITS.maxEntities),
    relations: z.array(z.unknown()).max(STORY_LIMITS.maxRelations),
    beats: z.array(z.unknown()).max(STORY_LIMITS.maxBeats),
    chronology: z.array(z.string()).max(STORY_LIMITS.maxBeats),
    centralQuestion: z.string().trim().max(STORY_LIMITS.maxCentralQuestionChars),
    finalConclusion: z.string().trim().max(STORY_LIMITS.maxFinalConclusionChars)
  })

  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) {
    return { ok: false, graph: null, rejectedItems: [], envelopeError: formatZodError(envelope.error) }
  }
  if (hasUnsafeMarkup(envelope.data.centralQuestion) || hasUnsafeMarkup(envelope.data.finalConclusion)) {
    return { ok: false, graph: null, rejectedItems: [], envelopeError: 'centralQuestion/finalConclusion contains disallowed HTML/script markup' }
  }

  const rejectedItems: RejectedNarrativeItem[] = []
  const durationBufferSeconds = 1

  const entities: NarrativeEntity[] = []
  const entityIds = new Set<string>()
  envelope.data.entities.forEach((rawEntity, index) => {
    const parsed = narrativeEntitySchema.safeParse(rawEntity)
    if (!parsed.success) {
      rejectedItems.push({ kind: 'entity', index, reason: formatZodError(parsed.error) })
      return
    }
    if (hasUnsafeMarkup(parsed.data.description) || parsed.data.aliases.some(hasUnsafeMarkup)) {
      rejectedItems.push({ kind: 'entity', index, reason: 'entity text contains disallowed HTML/script markup' })
      return
    }
    if (!context.segmentIds.has(parsed.data.firstSegmentId)) {
      rejectedItems.push({ kind: 'entity', index, reason: `firstSegmentId "${parsed.data.firstSegmentId}" does not match any transcript segment` })
      return
    }
    if (entityIds.has(parsed.data.id)) {
      rejectedItems.push({ kind: 'entity', index, reason: `duplicate entity id "${parsed.data.id}"` })
      return
    }
    entityIds.add(parsed.data.id)
    entities.push(parsed.data)
  })

  const relations: NarrativeRelation[] = []
  const relationIds = new Set<string>()
  envelope.data.relations.forEach((rawRelation, index) => {
    const parsed = narrativeRelationSchema.safeParse(rawRelation)
    if (!parsed.success) {
      rejectedItems.push({ kind: 'relation', index, reason: formatZodError(parsed.error) })
      return
    }
    if (hasUnsafeMarkup(parsed.data.label)) {
      rejectedItems.push({ kind: 'relation', index, reason: 'relation text contains disallowed HTML/script markup' })
      return
    }
    if (!entityIds.has(parsed.data.fromEntityId) || !entityIds.has(parsed.data.toEntityId)) {
      rejectedItems.push({ kind: 'relation', index, reason: 'fromEntityId/toEntityId does not match a valid entity' })
      return
    }
    const badSegment = parsed.data.segmentIds.find((id) => !context.segmentIds.has(id))
    if (badSegment) {
      rejectedItems.push({ kind: 'relation', index, reason: `segmentId "${badSegment}" does not match any transcript segment` })
      return
    }
    if (relationIds.has(parsed.data.id)) {
      rejectedItems.push({ kind: 'relation', index, reason: `duplicate relation id "${parsed.data.id}"` })
      return
    }
    relationIds.add(parsed.data.id)
    relations.push(parsed.data)
  })

  const beats: StoryBeat[] = []
  const beatIds = new Set<string>()
  envelope.data.beats.forEach((rawBeat, index) => {
    const parsed = storyBeatSchema.safeParse(rawBeat)
    if (!parsed.success) {
      rejectedItems.push({ kind: 'beat', index, reason: formatZodError(parsed.error) })
      return
    }
    const beat = parsed.data
    if (beat.endTime > context.mediaDurationSeconds + durationBufferSeconds) {
      rejectedItems.push({ kind: 'beat', index, reason: `endTime ${beat.endTime}s exceeds the media's duration (${context.mediaDurationSeconds}s)` })
      return
    }
    const badSegment = beat.segmentIds.find((id) => !context.segmentIds.has(id))
    if (badSegment) {
      rejectedItems.push({ kind: 'beat', index, reason: `segmentId "${badSegment}" does not match any transcript segment` })
      return
    }
    const badEntity = beat.entities.find((id) => !entityIds.has(id))
    if (badEntity) {
      rejectedItems.push({ kind: 'beat', index, reason: `entity id "${badEntity}" does not match any valid entity` })
      return
    }
    const badRelation = beat.relations.find((id) => !relationIds.has(id))
    if (badRelation) {
      rejectedItems.push({ kind: 'beat', index, reason: `relation id "${badRelation}" does not match any valid relation` })
      return
    }
    if (beatIds.has(beat.id)) {
      rejectedItems.push({ kind: 'beat', index, reason: `duplicate beat id "${beat.id}"` })
      return
    }
    beatIds.add(beat.id)
    beats.push(beat)
  })

  const chronology = envelope.data.chronology.filter((id) => beatIds.has(id))

  const graph: NarrativeGraph = {
    entities,
    relations,
    beats,
    chronology,
    centralQuestion: envelope.data.centralQuestion,
    finalConclusion: envelope.data.finalConclusion
  }
  return { ok: entities.length > 0 && beats.length > 0, graph, rejectedItems, envelopeError: null }
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid'
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  return `${path}${issue.message}`
}

// ---- Cloud provider/runtime state (Anthropic, mirrors shared/
// suggestions.ts's cloud-path shapes exactly -- this feature reuses the
// SAME consent-preview-then-confirm UI (CloudConsentModal.tsx +
// CloudRequestPreview) and the same never-persisted-consent convention) ----

export type StoryAnalysisErrorKind = ClaudeErrorKind

export interface StoryAnalysisError {
  kind: StoryAnalysisErrorKind
  message: string
  retryAfterSeconds?: number
}

export interface StoryAnalysisOptions {
  /** 0-100 -- mapped to the provider's sampling temperature. Kept low by
   * default: narrative fidelity to the transcript matters far more than
   * variety here (the model must not invent lore, chapter numbers, or
   * conclusions not present in the source text). */
  creativity: number
}

export const DEFAULT_STORY_ANALYSIS_OPTIONS: StoryAnalysisOptions = {
  creativity: 15
}

export interface GenerateNarrativeGraphResult {
  analysis: StoryAnalysis
  rejectedItems: RejectedNarrativeItem[]
  model: string
}

export const STORY_IPC = {
  previewAnalysis: 'story:previewAnalysis',
  analyzeStory: 'story:analyzeStory',
  cancelAnalysis: 'story:cancelAnalysis'
} as const

// ---- JSON Schema for Anthropic's tool-use `input_schema` ----
// Deliberately a SEPARATE, simpler schema object from the strict zod
// schemas above, built with real `z.enum(...)` fields instead of the
// `.refine`-based idFrom() helper -- a tool-use schema can steer generation
// toward valid enum values, but can't see through an opaque `.refine`
// predicate, and zod's `toJSONSchema()` throws on `.transform()` entirely.
// Cross-field checks (endTime > startTime, valid entity/relation
// references) also can't be expressed in a JSON Schema alone, so they're
// omitted here too. NONE of this relaxation is a safety boundary -- every
// graph the model produces under this schema still goes through
// validateNarrativeGraph() (with its `.refine`s and cross-reference checks
// intact) before anything is trusted. This schema only improves generation
// *yield*.
const genEntitySchema = z.object({
  id: z.string(),
  type: z.enum(NARRATIVE_ENTITY_TYPE_VALUES as [string, ...string[]]),
  canonicalName: z.string(),
  aliases: z.array(z.string()).max(STORY_LIMITS.maxAliasesPerEntity),
  description: z.string(),
  firstSegmentId: z.string(),
  color: z.string(),
  iconId: z.enum(TEMPLATE_ICON_IDS as [string, ...string[]]).optional(),
  imageAssetId: z.string().optional()
})

const genRelationSchema = z.object({
  id: z.string(),
  fromEntityId: z.string(),
  toEntityId: z.string(),
  type: z.enum(NARRATIVE_RELATION_TYPE_VALUES as [string, ...string[]]),
  label: z.string(),
  segmentIds: z.array(z.string()).max(STORY_LIMITS.maxSegmentIdsPerRelation)
})

const genBeatSchema = z.object({
  id: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  segmentIds: z.array(z.string()).max(STORY_LIMITS.maxSegmentIdsPerBeat),
  title: z.string(),
  summary: z.string(),
  purpose: z.string(),
  entities: z.array(z.string()).max(STORY_LIMITS.maxEntitiesPerBeat),
  relations: z.array(z.string()).max(STORY_LIMITS.maxRelationsPerBeat),
  evidence: z.array(z.string()).max(STORY_LIMITS.maxEvidenceItemsPerBeat).optional(),
  recommendedVisualization: z.enum(VISUALIZATION_TYPE_VALUES as unknown as [string, ...string[]]),
  importance: z.enum(STORY_BEAT_IMPORTANCE_VALUES as unknown as [string, ...string[]])
})

/** The raw shape asked of the model for one whole-story analysis request.
 * `chronology` is asked of the model directly (unlike ScenePlan's server-
 * filled envelope fields) because chronological beat ordering is itself
 * part of what the model must infer from the transcript. */
export function buildNarrativeGraphResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(
    z.object({
      entities: z.array(genEntitySchema).max(STORY_LIMITS.maxEntities),
      relations: z.array(genRelationSchema).max(STORY_LIMITS.maxRelations),
      beats: z.array(genBeatSchema).max(STORY_LIMITS.maxBeats),
      chronology: z.array(z.string()).max(STORY_LIMITS.maxBeats),
      centralQuestion: z.string(),
      finalConclusion: z.string()
    })
  ) as Record<string, unknown>
}

export const narrativeGraphModelResponseJsonSchema = buildNarrativeGraphResponseJsonSchema()
