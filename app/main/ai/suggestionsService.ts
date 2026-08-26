import { randomUUID } from 'crypto'
import { getApiKey } from './apiKeyStore'
import { AnthropicProvider } from './providers/AnthropicProvider'
import { ProviderError } from './providers/AiProvider'
import type { AiProvider, SegmentInput, ClassificationResult } from './providers/AiProvider'
import { computeCacheKey, readCache, writeCache } from './suggestionsCache'
import type { AiSuggestion, CloudRequestPreview, GenerateSuggestionsResult } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'

const provider: AiProvider = new AnthropicProvider()

// requestId -> AbortController, so a renderer-initiated cancel can reach the
// in-flight fetch regardless of which operation (generate/regenerate/simplify) started it.
const activeRequests = new Map<string, AbortController>()

export function cancelRequest(requestId: string): boolean {
  const controller = activeRequests.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
}

function toSegmentInputs(segments: TranscriptSegment[]): SegmentInput[] {
  return segments.map((seg) => ({ segmentId: seg.id, text: seg.editedText ?? seg.text }))
}

export function buildCloudRequestPreview(segments: TranscriptSegment[]): CloudRequestPreview {
  const inputs = toSegmentInputs(segments)
  const fullText = inputs.map((s) => s.text).join('\n')
  return {
    segmentCount: inputs.length,
    characterCount: fullText.length,
    textPreview: fullText.slice(0, 500),
    model: provider.model
  }
}

/** Turns raw provider results into AiSuggestion objects, always sourcing
 * startTime/endTime/originalText from the CURRENT transcript segment (never
 * trusting a possibly-stale copy from cache or from the model's echo) and
 * dropping anything that no longer references a real segment. */
function buildSuggestions(
  mediaId: string,
  segments: TranscriptSegment[],
  results: ClassificationResult[]
): { suggestions: AiSuggestion[]; missingSegmentIds: string[] } {
  const byId = new Map(segments.map((seg) => [seg.id, seg]))
  const requestedIds = new Set(segments.map((s) => s.id))
  const foundIds = new Set<string>()

  const suggestions: AiSuggestion[] = []
  for (const r of results) {
    const seg = byId.get(r.segmentId)
    if (!seg) continue // references a segment id that doesn't exist -- drop, don't trust it
    foundIds.add(r.segmentId)
    suggestions.push({
      id: randomUUID(),
      mediaId,
      segmentId: seg.id,
      startTime: seg.startTime,
      endTime: seg.endTime,
      purpose: r.purpose,
      originalText: seg.editedText ?? seg.text,
      visualText: r.visualText,
      reason: r.reason,
      confidence: r.confidence,
      status: 'suggested',
      locked: false,
      edited: false,
      createdAt: new Date().toISOString()
    })
  }
  suggestions.sort((a, b) => a.startTime - b.startTime)

  const missingSegmentIds = [...requestedIds].filter((id) => !foundIds.has(id))
  return { suggestions, missingSegmentIds }
}

/** Re-validates cached/existing suggestions against the CURRENT transcript
 * (segments may have been edited/removed since caching), refreshing
 * timing from the live segment rather than trusting the cached copy. */
export function revalidateSuggestions(suggestions: AiSuggestion[], segments: TranscriptSegment[]): AiSuggestion[] {
  const byId = new Map(segments.map((seg) => [seg.id, seg]))
  const result: AiSuggestion[] = []
  for (const s of suggestions) {
    const seg = byId.get(s.segmentId)
    if (!seg) continue
    result.push({ ...s, startTime: seg.startTime, endTime: seg.endTime })
  }
  return result
}

async function requireApiKey(): Promise<string> {
  const apiKey = await getApiKey()
  if (!apiKey) {
    throw new ProviderError('auth', 'No Anthropic API key is saved. Add one in AI Suggestions settings first.')
  }
  return apiKey
}

export async function generateSuggestions(
  requestId: string,
  mediaId: string,
  segments: TranscriptSegment[],
  forceRegenerate: boolean
): Promise<GenerateSuggestionsResult> {
  const apiKey = await requireApiKey()
  const inputs = toSegmentInputs(segments)
  const cacheKey = computeCacheKey(mediaId, inputs, provider.model)

  if (!forceRegenerate) {
    const cached = await readCache(cacheKey)
    if (cached) {
      return {
        suggestions: revalidateSuggestions(cached.suggestions, segments),
        model: cached.model,
        fromCache: true,
        missingSegmentIds: []
      }
    }
  }

  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    const results = await provider.classifySegments(apiKey, inputs, controller.signal)
    const { suggestions, missingSegmentIds } = buildSuggestions(mediaId, segments, results)
    await writeCache(cacheKey, suggestions, provider.model)
    return { suggestions, model: provider.model, fromCache: false, missingSegmentIds }
  } finally {
    activeRequests.delete(requestId)
  }
}

/** Regenerates exactly one segment's suggestion, always bypassing cache
 * (an explicit "try again" always means "give me a fresh answer"). Caller
 * is responsible for splicing the single result back into its own state
 * without touching other suggestions. */
export async function regenerateOne(
  requestId: string,
  mediaId: string,
  segment: TranscriptSegment
): Promise<AiSuggestion | null> {
  const apiKey = await requireApiKey()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    const results = await provider.classifySegments(apiKey, toSegmentInputs([segment]), controller.signal)
    const { suggestions } = buildSuggestions(mediaId, [segment], results)
    return suggestions[0] ?? null
  } finally {
    activeRequests.delete(requestId)
  }
}

export async function simplifySuggestionText(requestId: string, text: string): Promise<string> {
  const apiKey = await requireApiKey()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    return await provider.simplifyText(apiKey, text, controller.signal)
  } finally {
    activeRequests.delete(requestId)
  }
}

export { ProviderError }
