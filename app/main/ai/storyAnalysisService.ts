import { randomUUID } from 'crypto'
import { getApiKey } from './apiKeyStore'
import { StoryAnalysisProvider } from './providers/StoryAnalysisProvider'
import type { StoryAnalysisProviderInterface, StorySegmentInput } from './providers/StoryAnalysisProvider'
import { ProviderError } from './providers/AiProvider'
import { validateNarrativeGraph, STORY_SCHEMA_VERSION, STORY_LIMITS } from '@shared/story'
import type { StoryAnalysis, GenerateNarrativeGraphResult } from '@shared/story'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'

const provider: StoryAnalysisProviderInterface = new StoryAnalysisProvider()

// requestId -> AbortController, mirrors suggestionsService.ts's cancellation pattern.
const activeRequests = new Map<string, AbortController>()

export function cancelAnalysis(requestId: string): boolean {
  const controller = activeRequests.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
}

function toStorySegmentInputs(segments: TranscriptSegment[]): StorySegmentInput[] {
  return segments.map((seg) => ({ segmentId: seg.id, text: seg.editedText ?? seg.text, startTime: seg.startTime, endTime: seg.endTime }))
}

/** Pure, local, no network -- shown in the consent modal before the actual
 * request. Same shape as suggestionsService.ts's buildCloudRequestPreview,
 * reusing shared/suggestions.ts's CloudRequestPreview type directly rather
 * than inventing a parallel one for this feature. */
export function buildAnalysisPreview(segments: TranscriptSegment[]): CloudRequestPreview {
  const inputs = toStorySegmentInputs(segments)
  const fullText = inputs.map((s) => s.text).join('\n')
  return {
    segmentCount: inputs.length,
    characterCount: fullText.length,
    textPreview: fullText.slice(0, 500),
    model: provider.model
  }
}

/** A whole-story analysis is a single long-lived HTTPS request (observed
 * live to run 90-300+ seconds) -- transient network blips or a dropped
 * idle connection are more likely here than for a short classification
 * call, and are indistinguishable from a real outage until retried. One
 * automatic retry on a `network`/`timeout` failure (never on `auth`,
 * `rate-limit`, `schema`, or `canceled` -- those won't be fixed by
 * retrying, and canceling mid-request must actually stop, not retry) is
 * cheap insurance for an operation the user already opted into and waited
 * minutes for. */
async function analyzeWithRetry(apiKey: string, inputs: StorySegmentInput[], creativity: number, signal: AbortSignal): Promise<unknown> {
  try {
    return await provider.analyzeNarrative(apiKey, inputs, creativity, signal)
  } catch (err) {
    const retryable = err instanceof ProviderError && (err.kind === 'network' || err.kind === 'timeout')
    if (!retryable || signal.aborted) throw err
    return await provider.analyzeNarrative(apiKey, inputs, creativity, signal)
  }
}

async function requireApiKey(): Promise<string> {
  const apiKey = await getApiKey()
  if (!apiKey) {
    throw new ProviderError('auth', 'No Anthropic API key is saved. Add one in AI Suggestions settings first.')
  }
  return apiKey
}

export async function analyzeStory(
  requestId: string,
  mediaId: string,
  segments: TranscriptSegment[],
  mediaDurationSeconds: number,
  creativity: number
): Promise<GenerateNarrativeGraphResult> {
  const apiKey = await requireApiKey()

  if (segments.length > STORY_LIMITS.maxSegmentCount) {
    throw new ProviderError('malformed', `Transcript has ${segments.length} segments, over the ${STORY_LIMITS.maxSegmentCount} limit for one story analysis.`)
  }
  const inputs = toStorySegmentInputs(segments)
  const fullTextChars = inputs.reduce((sum, s) => sum + s.text.length, 0)
  if (fullTextChars > STORY_LIMITS.maxTranscriptChars) {
    throw new ProviderError('malformed', `Transcript is ${fullTextChars} characters, over the ${STORY_LIMITS.maxTranscriptChars} limit for one story analysis.`)
  }

  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    const raw = await analyzeWithRetry(apiKey, inputs, creativity, controller.signal)

    const rawText = JSON.stringify(raw)
    if (rawText.length > STORY_LIMITS.maxOutputChars) {
      throw new ProviderError('schema', 'Model response was too large to safely process.')
    }

    const segmentIds = new Set(segments.map((s) => s.id))
    const validation = validateNarrativeGraph(raw, { segmentIds, mediaDurationSeconds })
    if (!validation.ok || !validation.graph) {
      // Surface WHY validation failed -- envelopeError (whole-response shape
      // problem) or a sample of individual item rejection reasons (schema
      // issue descriptions only, e.g. "unknown entity type" -- never the
      // transcript text itself, matching the "never log transcript content"
      // rule while still being genuinely diagnostic instead of a dead end).
      const rejectedSample = validation.rejectedItems
        .slice(0, 3)
        .map((r) => `${r.kind}[${r.index}]: ${r.reason}`)
        .join('; ')
      const detail = validation.envelopeError ?? (rejectedSample || 'the model returned zero entities and beats')
      throw new ProviderError('schema', `Model response contained no valid entities or story beats after validation. ${detail}`)
    }

    const analysis: StoryAnalysis = {
      version: STORY_SCHEMA_VERSION,
      id: randomUUID(),
      mediaId,
      model: provider.model,
      generatedAt: new Date().toISOString(),
      graph: validation.graph
    }
    return { analysis, rejectedItems: validation.rejectedItems, model: provider.model }
  } finally {
    activeRequests.delete(requestId)
  }
}

export { ProviderError }
