// Local AI Scene and Template Planner -- shared types, hard limits, and the
// strict ScenePlan validator, importable from both the main process (which
// talks to Ollama and never trusts its output) and the renderer (which
// previews/edits a validated plan before it ever touches the project).
//
// Architecture: a ScenePlan is NOT a Scene. It's a lighter, fully-validated
// intermediate shape the local model is asked to produce -- one step lighter
// than the real Scene type (no track, no id-collision concerns, no
// brandOverrides/position/etc), converted into real Scene objects only at
// "Apply" time (see renderer/src/localAi/scenePlanToScenes.ts), the same way
// the existing cloud AiSuggestion is lighter than Scene until accepted (see
// shared/suggestions.ts's own doc comment). This keeps the validation
// surface small and keeps "what the model is allowed to say" decoupled from
// "everything a Scene can eventually be styled into."
//
// Distinct from shared/suggestions.ts's AI_IPC (cloud, Anthropic) -- this
// feature is local-only (Ollama today, a bundled llama.cpp sidecar later,
// see app/main/ai/providers/LocalAiProvider.ts) and never makes a network
// request beyond 127.0.0.1.
import { z } from 'zod'
import { PURPOSE_VALUES, type CommunicationPurpose } from './suggestions'
import {
  TEMPLATE_IDS,
  TEMPLATE_ICON_IDS,
  PRESENTATION_MODE_VALUES,
  SCENE_BACKGROUND_MODE_VALUES,
  MOTION_PRESET_VALUES,
  TEMPLATE_CATEGORY,
  type TemplateId,
  type TemplateIconId,
  type PresentationMode,
  type SceneBackgroundMode,
  type MotionPreset,
  type TemplateCategory
} from './templates'

// ---- Hard limits (spec section 7: "Apply hard limits for input length,
// output size, timeout, memory use, and cancellation") ----
export const SCENE_PLAN_LIMITS = {
  /** Reject the whole plan outright above this -- a legitimate transcript
   * never needs more graphics scenes than this; a local model that emits
   * more is either confused or being adversarial, and either way nothing
   * past this count should reach validation at all. */
  maxScenesInPlan: 40,
  /** Characters of transcript text fed to the model per request -- longer
   * transcripts are chunked by the caller (see localAiService.ts), never
   * silently truncated mid-segment. */
  maxTranscriptCharsPerRequest: 12_000,
  maxSceneTitleChars: 120,
  maxSceneTextChars: 400,
  maxItemsPerScene: 6,
  maxItemLabelChars: 80,
  maxExplanationChars: 300,
  /** Wall-clock budget for one generation request, including local model
   * load time. */
  requestTimeoutMs: 120_000,
  /** Raw model output is rejected without even attempting JSON.parse past
   * this many characters -- bounds worst-case memory for a runaway/looping
   * local model regardless of what its own num_predict cap is set to. */
  maxOutputChars: 200_000,
  /** A transcript with more segments than this is rejected outright before
   * any batching/generation is attempted -- batching bounds per-request
   * character count, but an absurd segment count (e.g. a corrupted
   * transcript with thousands of 1-word segments) would still mean an
   * unbounded number of sequential model calls otherwise. */
  maxSegmentCount: 400
} as const

const colorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'must be a hex color like #5b8cff')

/** Every scene's free-text fields already render as plain React text nodes
 * nowhere in the app do templates use dangerouslySetInnerHTML, so this is
 * defense-in-depth on top of React's own escaping, not the only thing
 * standing between a malicious model response and script execution. Kept
 * deliberately narrow (real tag/scheme markers only) to avoid false-
 * positives on ordinary narration text that happens to contain a bare `<`. */
const UNSAFE_MARKUP_RE = /<\s*\/?\s*(script|iframe|object|embed|svg|style)\b|javascript:|data:text\/html/i

function hasUnsafeMarkup(text: string | undefined): boolean {
  return typeof text === 'string' && UNSAFE_MARKUP_RE.test(text)
}

/** `z.enum` wants a literal tuple; the app's real id lists are plain
 * `T[]` (extended over time, e.g. new templates/icons) so validating
 * against them directly -- via `.refine`, not a duplicated literal list --
 * means this validator can never drift out of sync with what the app
 * actually supports. */
function idFrom<T extends string>(values: readonly T[], label: string) {
  const set = new Set<string>(values)
  return z
    .string()
    .refine((v): v is T => set.has(v), { message: `unknown ${label}` })
    .transform((v) => v as T)
}

const scenePlanItemSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(SCENE_PLAN_LIMITS.maxItemLabelChars),
  description: z.string().trim().max(200).optional(),
  value: z.string().trim().max(80).optional(),
  iconId: idFrom<TemplateIconId>(TEMPLATE_ICON_IDS, 'icon id').optional(),
  color: colorSchema.optional()
})

const scenePlanContentSchema = z.object({
  eyebrow: z.string().trim().max(60).optional(),
  title: z.string().trim().max(SCENE_PLAN_LIMITS.maxSceneTitleChars).optional(),
  subtitle: z.string().trim().max(SCENE_PLAN_LIMITS.maxSceneTitleChars).optional(),
  body: z.string().trim().max(SCENE_PLAN_LIMITS.maxSceneTextChars).optional(),
  value: z.string().trim().max(80).optional(),
  items: z.array(scenePlanItemSchema).max(SCENE_PLAN_LIMITS.maxItemsPerScene).optional(),
  cta: z.string().trim().max(80).optional()
})

const scenePlanMotionSchema = z.object({
  preset: idFrom<MotionPreset>(MOTION_PRESET_VALUES, 'motion preset').optional(),
  /** 0-100, matches Scene.motionIntensity's own documented range. */
  intensity: z.number().finite().min(0).max(100).optional(),
  /** Seconds between staggered elements -- matches Scene.staggerDelay. */
  stagger: z.number().finite().min(0).max(5).optional(),
  loop: z.boolean().optional()
})

const scenePlanBackgroundSchema = z.object({
  mode: idFrom<SceneBackgroundMode>(SCENE_BACKGROUND_MODE_VALUES, 'background mode').optional(),
  /** 0-100, matches Scene.background.intensity's own documented range --
   * named `opacity` here to match the spec's own wording for this field. */
  opacity: z.number().finite().min(0).max(100).optional(),
  glowColor: colorSchema.optional()
})

const scenePlanIconSchema = z.object({
  iconId: idFrom<TemplateIconId>(TEMPLATE_ICON_IDS, 'icon id').optional(),
  color: colorSchema.optional()
})

export const scenePlanSceneSchema = z
  .object({
    /** Client-generated id for this plan item, scoped to the plan --
     * distinct from the eventual Scene.id minted only at Apply time. */
    id: z.string().trim().min(1).max(80),
    /** The TranscriptSegment.id this scene is derived from -- cross-checked
     * against the real transcript by validateScenePlan below, never trusted
     * on the model's say-so alone. */
    segmentId: z.string().trim().min(1).max(80),
    startTime: z.number().finite().min(0).max(86_400),
    endTime: z.number().finite().min(0).max(86_400),
    purpose: idFrom<CommunicationPurpose>(PURPOSE_VALUES, 'communication purpose'),
    templateId: idFrom<TemplateId>(TEMPLATE_IDS, 'template id'),
    content: scenePlanContentSchema,
    icon: scenePlanIconSchema.optional(),
    presentationMode: idFrom<PresentationMode>(PRESENTATION_MODE_VALUES, 'presentation mode').optional(),
    background: scenePlanBackgroundSchema.optional(),
    motion: scenePlanMotionSchema.optional(),
    confidence: z.number().finite().min(0).max(1),
    explanation: z.string().trim().min(1).max(SCENE_PLAN_LIMITS.maxExplanationChars)
  })
  .refine((s) => s.endTime > s.startTime, { message: 'endTime must be after startTime', path: ['endTime'] })
  .refine((s) => s.endTime - s.startTime <= 120, { message: 'a single scene cannot span more than 120s', path: ['endTime'] })
  .refine(
    (s) => {
      const c = s.content
      const textFields = [c.eyebrow, c.title, c.subtitle, c.body, c.value, c.cta, s.explanation, ...(c.items ?? []).flatMap((i) => [i.label, i.description, i.value])]
      return !textFields.some(hasUnsafeMarkup)
    },
    { message: 'scene text contains disallowed HTML/script markup', path: ['content'] }
  )

export type ScenePlanItem = z.infer<typeof scenePlanItemSchema>
export type ScenePlanContent = z.infer<typeof scenePlanContentSchema>
export type ScenePlanMotion = z.infer<typeof scenePlanMotionSchema>
export type ScenePlanBackground = z.infer<typeof scenePlanBackgroundSchema>
export type ScenePlanIcon = z.infer<typeof scenePlanIconSchema>
export type ScenePlanScene = z.infer<typeof scenePlanSceneSchema>

/** Bumped whenever this shape changes in a way that makes an old raw model
 * response (if ever cached) unsafe to reuse without re-validating. */
export const SCENE_PLAN_SCHEMA_VERSION = 1

export interface ScenePlan {
  version: typeof SCENE_PLAN_SCHEMA_VERSION
  mediaId: string
  model: string
  generatedAt: string
  scenes: ScenePlanScene[]
}

/** One malformed/rejected scene from an otherwise-usable plan -- surfaced to
 * the user rather than silently dropped, matching the existing cloud path's
 * `missingSegmentIds` transparency convention (shared/suggestions.ts). */
export interface RejectedScenePlanScene {
  index: number
  reason: string
}

export interface ScenePlanValidationResult {
  ok: boolean
  plan: ScenePlan | null
  rejectedScenes: RejectedScenePlanScene[]
  /** Non-empty only when the whole envelope was invalid (not a single-model,
   * not JSON, too many scenes, wrong mediaId, etc) -- `plan` is null in that case. */
  envelopeError: string | null
}

interface ValidationContext {
  mediaId: string
  /** Real TranscriptSegment ids for this media -- any scene referencing an
   * id outside this set is rejected individually rather than trusted. */
  segmentIds: ReadonlySet<string>
  /** The underlying media asset's real duration -- any scene whose endTime
   * exceeds it (beyond a small rounding buffer) is rejected individually. */
  mediaDurationSeconds: number
}

/** The single validation entry point every raw local-model response must
 * pass through before it can influence the project in any way (spec
 * section 3/7: "Validate with a shared schema before modifying the
 * project" / "Reject unknown template IDs, icon IDs, malformed times,
 * invalid colors, and excessive scene counts"). Never throws -- always
 * returns a result, even for input that isn't valid JSON at all. */
export function validateScenePlan(raw: unknown, context: ValidationContext): ScenePlanValidationResult {
  const envelopeSchema = z.object({
    version: z.literal(SCENE_PLAN_SCHEMA_VERSION),
    mediaId: z.string().trim().min(1),
    model: z.string().trim().min(1).max(200),
    generatedAt: z.string().trim().min(1),
    scenes: z.array(z.unknown()).max(SCENE_PLAN_LIMITS.maxScenesInPlan)
  })

  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) {
    return { ok: false, plan: null, rejectedScenes: [], envelopeError: formatZodError(envelope.error) }
  }
  if (envelope.data.mediaId !== context.mediaId) {
    return { ok: false, plan: null, rejectedScenes: [], envelopeError: `plan mediaId "${envelope.data.mediaId}" does not match the requested media` }
  }

  const scenes: ScenePlanScene[] = []
  const rejectedScenes: RejectedScenePlanScene[] = []
  const durationBufferSeconds = 1 // rounding slack only, never a loophole for a genuinely out-of-range time

  envelope.data.scenes.forEach((rawScene, index) => {
    const parsed = scenePlanSceneSchema.safeParse(rawScene)
    if (!parsed.success) {
      rejectedScenes.push({ index, reason: formatZodError(parsed.error) })
      return
    }
    const scene = parsed.data
    if (!context.segmentIds.has(scene.segmentId)) {
      rejectedScenes.push({ index, reason: `segmentId "${scene.segmentId}" does not match any transcript segment` })
      return
    }
    if (scene.endTime > context.mediaDurationSeconds + durationBufferSeconds) {
      rejectedScenes.push({ index, reason: `endTime ${scene.endTime}s exceeds the media's duration (${context.mediaDurationSeconds}s)` })
      return
    }
    scenes.push(scene)
  })

  const plan: ScenePlan = { version: SCENE_PLAN_SCHEMA_VERSION, mediaId: envelope.data.mediaId, model: envelope.data.model, generatedAt: envelope.data.generatedAt, scenes }
  return { ok: scenes.length > 0, plan, rejectedScenes, envelopeError: null }
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid'
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  return `${path}${issue.message}`
}

// ---- Local AI provider/runtime state (Ollama today, see
// app/main/ai/providers/OllamaProvider.ts; a bundled llama.cpp sidecar can
// implement the same LocalAiProvider interface later without touching any
// of the types below) ----

export type LocalAiRuntimeStatus = 'not-installed' | 'installed-not-running' | 'running' | 'unknown'

export interface LocalAiHealth {
  status: LocalAiRuntimeStatus
  /** The provider's own reported version string, e.g. Ollama's `/api/version`. */
  version?: string
  providerName: string
}

export interface LocalModelInfo {
  /** The provider's own model identifier, e.g. Ollama's `"qwen2.5:7b"`. */
  id: string
  /** True once cross-checked against the provider's local inventory. */
  installed: boolean
  sizeBytes?: number
  /** True if currently loaded/resident (Ollama's `/api/ps`). */
  loaded?: boolean
}

export interface ModelPullProgress {
  requestId: string
  model: string
  /** 0-100. */
  percent: number
  /** Bytes, when known. */
  completedBytes?: number
  totalBytes?: number
  status: 'pulling' | 'verifying' | 'success' | 'error' | 'canceled'
  message?: string
}

export type LocalAiErrorKind =
  | 'not-installed'
  | 'not-running'
  | 'model-not-found'
  | 'network'
  | 'timeout'
  | 'malformed'
  | 'schema'
  | 'canceled'
  | 'input-too-large'
  | 'unknown'

export interface LocalAiError {
  kind: LocalAiErrorKind
  message: string
}

export interface GenerateScenePlanResult {
  plan: ScenePlan
  rejectedScenes: RejectedScenePlanScene[]
  model: string
}

// ---- Quality controls -- user-tunable knobs over generation, layered on
// top of (never a substitute for) the hard safety limits above. Every one
// of these is enforced deterministically in shared/main-process code, never
// left to the model to "agree" to via a prompt instruction alone. ----

export const SCENE_DENSITY_VALUES = ['minimal', 'balanced', 'rich'] as const
export type SceneDensity = (typeof SCENE_DENSITY_VALUES)[number]

export interface ScenePlanGenerationOptions {
  /** 0-100 -- mapped to the model's sampling temperature. Higher values
   * allow more varied scene/wording choices; 0 is fully deterministic. */
  creativity: number
  /** How many segments should end up with a proposed scene, in spirit --
   * "minimal" only the clearly essential ones, "rich" most segments that
   * could plausibly benefit. Steers the system prompt; the model can still
   * legitimately return fewer (or zero) scenes than the density implies. */
  density: SceneDensity
  /** Caps how many scenes may be simultaneously on-screen (time ranges
   * overlapping) anywhere in the plan -- enforced deterministically after
   * generation (see enforceQualityFilters), not left to the model. */
  maxSimultaneousGraphics: number
  /** Empty = no preference (every registered template category allowed).
   * Non-empty narrows the generation-time templateId enum toward these
   * categories (a yield improvement only -- validateScenePlan still accepts
   * any registered template regardless of this setting). */
  preferredCategories: TemplateCategory[]
  /** 0-1 -- scenes below this confidence are dropped after generation
   * (see enforceQualityFilters). */
  minConfidence: number
}

export const DEFAULT_SCENE_PLAN_OPTIONS: ScenePlanGenerationOptions = {
  creativity: 30,
  density: 'balanced',
  maxSimultaneousGraphics: 3,
  preferredCategories: [],
  minConfidence: 0
}

/** Resolves `preferredCategories` down to the concrete template ids the
 * generation-time JSON schema should be narrowed to (see
 * buildScenePlanResponseJsonSchema) -- empty categories, or categories that
 * happen to match zero registered templates, both fall back to every
 * registered template rather than producing an impossible-to-satisfy
 * schema. */
export function templateIdsForCategories(categories: readonly TemplateCategory[]): TemplateId[] {
  if (categories.length === 0) return [...TEMPLATE_IDS]
  const allowed = new Set(categories)
  const matches = TEMPLATE_IDS.filter((id) => allowed.has(TEMPLATE_CATEGORY[id]))
  return matches.length > 0 ? matches : [...TEMPLATE_IDS]
}

export interface DroppedScenePlanScene {
  scene: ScenePlanScene
  reason: string
}

/** Applies the `minConfidence` and `maxSimultaneousGraphics` quality
 * controls to an already-validated, already-safe list of scenes. Pure and
 * deterministic -- given the same scenes and options, always keeps/drops
 * the same ones, so the deterministic preview summary (renderer) and the
 * actual generation result (main process) can never disagree.
 *
 * `maxSimultaneousGraphics` is enforced by a greedy highest-confidence-first
 * pass: a candidate is kept only if it wouldn't push the number of
 * time-overlapping already-kept scenes past the limit, so when scenes must
 * be dropped to make room, the lowest-confidence ones go first. The kept
 * set is returned back in chronological (startTime) order. */
export function enforceQualityFilters(
  scenes: readonly ScenePlanScene[],
  options: Pick<ScenePlanGenerationOptions, 'minConfidence' | 'maxSimultaneousGraphics'>
): { kept: ScenePlanScene[]; dropped: DroppedScenePlanScene[] } {
  const dropped: DroppedScenePlanScene[] = []

  const passedConfidence = scenes.filter((s) => {
    if (s.confidence < options.minConfidence) {
      dropped.push({ scene: s, reason: `confidence ${s.confidence.toFixed(2)} is below the minimum ${options.minConfidence.toFixed(2)}` })
      return false
    }
    return true
  })

  const byConfidenceDesc = [...passedConfidence].sort((a, b) => b.confidence - a.confidence)
  const kept: ScenePlanScene[] = []
  const cap = Math.max(1, options.maxSimultaneousGraphics)
  for (const candidate of byConfidenceDesc) {
    const overlapCount = kept.filter((k) => k.startTime < candidate.endTime && candidate.startTime < k.endTime).length
    if (overlapCount < cap) {
      kept.push(candidate)
    } else {
      dropped.push({ scene: candidate, reason: `would exceed the maximum of ${cap} simultaneous graphic${cap === 1 ? '' : 's'}` })
    }
  }
  kept.sort((a, b) => a.startTime - b.startTime)
  return { kept, dropped }
}

// ---- JSON Schema for Ollama's grammar-constrained `format` field ----
// Deliberately a SEPARATE, simpler schema object from scenePlanSceneSchema
// above, built with real `z.enum(...)` fields instead of the `.refine`-based
// idFrom() helper: Ollama's structured-output grammar compiler can steer
// generation toward valid enum values, but only reads a value's declared
// JSON Schema shape -- it can't see through an opaque `.refine` predicate,
// and zod's `toJSONSchema()` throws on `.transform()` entirely. Cross-field
// checks (endTime > startTime) also can't be expressed in a JSON Schema a
// context-free grammar consumes, so they're omitted here too. NONE of this
// relaxation is a safety boundary -- every scene the model produces under
// this schema still goes through validateScenePlan() (the real
// scenePlanSceneSchema, with its `.refine`s intact) before anything is
// trusted. This schema only improves generation *yield*.
const genItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  value: z.string().optional(),
  iconId: z.enum(TEMPLATE_ICON_IDS as [string, ...string[]]).optional(),
  color: z.string().optional()
})

const genContentSchema = z.object({
  eyebrow: z.string().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  value: z.string().optional(),
  items: z.array(genItemSchema).max(SCENE_PLAN_LIMITS.maxItemsPerScene).optional(),
  cta: z.string().optional()
})

/** `allowedTemplateIds` narrows the templateId enum the model's grammar is
 * steered toward -- used to bias generation toward the user's preferred
 * template categories (a quality control, not a safety boundary: every
 * scene still passes through the real scenePlanSceneSchema, which accepts
 * ANY registered template regardless of what this narrower schema asked
 * for). Falls back to every registered template when empty. */
function buildGenSceneSchema(allowedTemplateIds: readonly TemplateId[]) {
  const ids = allowedTemplateIds.length > 0 ? allowedTemplateIds : TEMPLATE_IDS
  return z.object({
  id: z.string(),
  segmentId: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  purpose: z.enum(PURPOSE_VALUES as [string, ...string[]]),
  templateId: z.enum(ids as [string, ...string[]]),
  content: genContentSchema,
  icon: z
    .object({
      iconId: z.enum(TEMPLATE_ICON_IDS as [string, ...string[]]).optional(),
      color: z.string().optional()
    })
    .optional(),
  presentationMode: z.enum(PRESENTATION_MODE_VALUES as [string, ...string[]]).optional(),
  background: z
    .object({
      mode: z.enum(SCENE_BACKGROUND_MODE_VALUES as [string, ...string[]]).optional(),
      opacity: z.number().optional(),
      glowColor: z.string().optional()
    })
    .optional(),
  motion: z
    .object({
      preset: z.enum(MOTION_PRESET_VALUES as [string, ...string[]]).optional(),
      intensity: z.number().optional(),
      stagger: z.number().optional(),
      loop: z.boolean().optional()
    })
    .optional(),
  confidence: z.number(),
  explanation: z.string()
  })
}

/** The raw shape asked of the local model for one batch: just the scenes it
 * proposes for the segments it was given. `version`/`mediaId`/`model`/
 * `generatedAt` are filled in server-side (app/main/ai/localAiService.ts)
 * rather than asked of the model -- there's no reason to make generation
 * less reliable by asking it to echo back an id it can't get wrong-free. */
export function buildScenePlanResponseJsonSchema(allowedTemplateIds: readonly TemplateId[] = TEMPLATE_IDS): Record<string, unknown> {
  return z.toJSONSchema(z.object({ scenes: z.array(buildGenSceneSchema(allowedTemplateIds)).max(SCENE_PLAN_LIMITS.maxScenesInPlan) })) as Record<string, unknown>
}

export const scenePlanModelResponseJsonSchema = buildScenePlanResponseJsonSchema()

export const LOCAL_AI_IPC = {
  getHealth: 'localAi:getHealth',
  listModels: 'localAi:listModels',
  pullModel: 'localAi:pullModel',
  cancelPull: 'localAi:cancelPull',
  retryPull: 'localAi:retryPull',
  unloadModel: 'localAi:unloadModel',
  pullProgress: 'localAi:pullProgress',
  generateScenePlan: 'localAi:generateScenePlan',
  cancelGenerate: 'localAi:cancelGenerate'
} as const
