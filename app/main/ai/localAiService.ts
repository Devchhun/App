import { randomUUID } from 'crypto'
import {
  SCENE_PLAN_LIMITS,
  SCENE_PLAN_SCHEMA_VERSION,
  buildScenePlanResponseJsonSchema,
  templateIdsForCategories,
  enforceQualityFilters,
  validateScenePlan,
  DEFAULT_SCENE_PLAN_OPTIONS,
  type GenerateScenePlanResult,
  type LocalAiHealth,
  type LocalModelInfo,
  type ModelPullProgress,
  type RejectedScenePlanScene,
  type ScenePlanScene,
  type ScenePlanGenerationOptions,
  type SceneDensity
} from '@shared/localAi'
import type { TranscriptSegment } from '@shared/transcription'
import { OllamaProvider } from './providers/OllamaProvider'
import { LocalAiProviderError, type LocalAiProvider } from './providers/LocalAiProvider'

const provider: LocalAiProvider = new OllamaProvider()

// requestId -> AbortController, so a renderer-initiated cancel can reach the
// in-flight request regardless of which batch it's currently on -- same
// pattern as suggestionsService.ts's activeRequests map for the cloud path.
const activeRequests = new Map<string, AbortController>()

export function cancelRequest(requestId: string): boolean {
  const controller = activeRequests.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
}

export async function getHealth(): Promise<LocalAiHealth> {
  return provider.checkHealth()
}

export async function listModels(): Promise<LocalModelInfo[]> {
  return provider.listModels()
}

export async function pullModel(requestId: string, model: string, onProgress: (p: ModelPullProgress) => void): Promise<void> {
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    await provider.pullModel(model, (p) => onProgress({ ...p, requestId }), controller.signal)
  } finally {
    activeRequests.delete(requestId)
  }
}

export async function unloadModel(model: string): Promise<void> {
  return provider.unloadModel(model)
}

const DENSITY_INSTRUCTIONS: Record<SceneDensity, string> = {
  minimal: 'Be sparing: only propose a scene for a segment when a graphic is clearly essential (a name, a critical statistic, a warning). Prefer fewer, higher-confidence scenes over covering every possible moment.',
  balanced: 'Only propose a scene for a segment when a graphic would genuinely help the viewer (a name, a statistic, a warning, a short list, a key claim). Do not propose a scene for every segment.',
  rich: 'Be generous: propose a scene for most segments that could plausibly benefit from a graphic, not just the most obvious ones -- err on the side of including one.'
}

function buildSystemPrompt(density: SceneDensity): string {
  return `You are a local, offline scene-planning assistant for a video editor. You analyze narration transcript segments (Khmer, English, or mixed) and propose short on-screen motion-graphics scenes to accompany them.

Rules you must follow exactly:
- Output ONLY the JSON object matching the required schema. Never output prose, markdown, code fences, React/TypeScript/JavaScript code, shell commands, or any executable content of any kind -- your entire response is data, never code.
- ${DENSITY_INSTRUCTIONS[density]}
- Every scene's segmentId must be one of the segment ids given to you below -- never invent one.
- startTime/endTime must stay within that segment's own [start, end] time range.
- Keep on-screen text short (a few words), not a repeated full sentence. Preserve the original language of the narration (Khmer text stays Khmer).
- Pick the templateId that best fits the content's communication purpose.
- confidence is 0-1. explanation is one short sentence in English describing why you chose this scene.
- If nothing in the given segments warrants a graphic, return an empty scenes array.`
}

function buildUserPrompt(segments: TranscriptSegment[]): string {
  const lines = segments.map((s) => `[${s.id}] (${s.startTime.toFixed(2)}s - ${s.endTime.toFixed(2)}s) ${s.editedText ?? s.text}`).join('\n')
  return `Narration segments:\n\n${lines}\n\nPropose scenes for the segments above that genuinely warrant an on-screen graphic.`
}

/** Greedily packs segments into batches that each stay under the
 * per-request character budget (spec section 7: input length hard limit) --
 * a transcript longer than one batch is chunked into several sequential
 * requests rather than truncated or rejected outright. */
function batchSegments(segments: TranscriptSegment[]): TranscriptSegment[][] {
  const batches: TranscriptSegment[][] = []
  let current: TranscriptSegment[] = []
  let currentChars = 0

  for (const seg of segments) {
    const text = seg.editedText ?? seg.text
    if (current.length > 0 && currentChars + text.length > SCENE_PLAN_LIMITS.maxTranscriptCharsPerRequest) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(seg)
    currentChars += text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export async function generateScenePlan(
  requestId: string,
  mediaId: string,
  segments: TranscriptSegment[],
  mediaDurationSeconds: number,
  model: string,
  options: ScenePlanGenerationOptions = DEFAULT_SCENE_PLAN_OPTIONS
): Promise<GenerateScenePlanResult> {
  if (segments.length === 0) {
    return { plan: { version: SCENE_PLAN_SCHEMA_VERSION, mediaId, model, generatedAt: new Date().toISOString(), scenes: [] }, rejectedScenes: [], model }
  }

  if (segments.length > SCENE_PLAN_LIMITS.maxSegmentCount) {
    throw new LocalAiProviderError('input-too-large', `Transcript has too many segments to plan (${segments.length}, max ${SCENE_PLAN_LIMITS.maxSegmentCount}).`)
  }

  const totalChars = segments.reduce((sum, s) => sum + (s.editedText ?? s.text).length, 0)
  const maxTotalChars = SCENE_PLAN_LIMITS.maxTranscriptCharsPerRequest * 20 // batching handles normal length; this is the absolute ceiling
  if (totalChars > maxTotalChars) {
    throw new LocalAiProviderError('input-too-large', `Transcript is too long to plan in one request (${totalChars} characters).`)
  }

  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  const segmentIds = new Set(segments.map((s) => s.id))
  const generatedAt = new Date().toISOString()
  const systemPrompt = buildSystemPrompt(options.density)
  const jsonSchema = buildScenePlanResponseJsonSchema(templateIdsForCategories(options.preferredCategories))
  const temperature = Math.max(0, Math.min(100, options.creativity)) / 100

  try {
    const batches = batchSegments(segments)
    const scenes: ScenePlanScene[] = []
    const rejectedScenes: RejectedScenePlanScene[] = []
    let indexOffset = 0

    for (const batch of batches) {
      if (controller.signal.aborted) throw new LocalAiProviderError('canceled', 'Request canceled')
      if (scenes.length >= SCENE_PLAN_LIMITS.maxScenesInPlan) break

      const raw = await provider.generateJson(
        {
          mediaId,
          model,
          systemPrompt,
          userPrompt: buildUserPrompt(batch),
          jsonSchema,
          temperature
        },
        controller.signal
      )

      const rawScenesArray = raw && typeof raw === 'object' && Array.isArray((raw as { scenes?: unknown }).scenes) ? (raw as { scenes: unknown[] }).scenes : []
      const envelope = { version: SCENE_PLAN_SCHEMA_VERSION, mediaId, model, generatedAt, scenes: rawScenesArray }
      const result = validateScenePlan(envelope, { mediaId, segmentIds, mediaDurationSeconds })

      if (result.plan) scenes.push(...result.plan.scenes)
      for (const r of result.rejectedScenes) rejectedScenes.push({ index: indexOffset + r.index, reason: r.reason })
      if (!result.plan && result.envelopeError) {
        rejectedScenes.push({ index: indexOffset, reason: `batch rejected: ${result.envelopeError}` })
      }
      indexOffset += rawScenesArray.length
    }

    const { kept, dropped } = enforceQualityFilters(scenes, options)
    for (const d of dropped) rejectedScenes.push({ index: -1, reason: `"${d.scene.id}" dropped by quality controls: ${d.reason}` })
    const capped = kept.slice(0, SCENE_PLAN_LIMITS.maxScenesInPlan)
    return {
      plan: { version: SCENE_PLAN_SCHEMA_VERSION, mediaId, model, generatedAt, scenes: capped },
      rejectedScenes,
      model
    }
  } finally {
    activeRequests.delete(requestId)
  }
}

export { LocalAiProviderError }
export const generateRequestId = (): string => randomUUID()
