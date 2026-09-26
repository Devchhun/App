import { getApiKey } from './apiKeyStore'
import { AnthropicProvider } from './providers/AnthropicProvider'
import { ProviderError } from './providers/AiProvider'
import type { AiProvider, SegmentInput } from './providers/AiProvider'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { TranslateSubtitlesResult, TranslationResult } from '@shared/translation'
import type { TranscriptSegment } from '@shared/transcription'
import { hasGeminiApiKey } from './geminiApiKeyStore'
import { GEMINI_TRANSLATION_MODEL, translateSegmentsWithGemini } from './geminiTranslationService'

const provider: AiProvider = new AnthropicProvider()

/** Which service translates. Gemini whenever its key is saved -- it is the
 * key Auto SRT already needs, so a user who just generated an SRT can
 * translate it without also buying a Claude key -- and Claude otherwise. */
type TranslationEngine = 'gemini' | 'anthropic'
async function chooseEngine(): Promise<TranslationEngine> {
  return (await hasGeminiApiKey()) ? 'gemini' : 'anthropic'
}

// requestId -> AbortController, mirrors suggestionsService.ts's own
// activeRequests map exactly (a separate map -- translation and AI
// Suggestions requests are cancelled independently of each other).
const activeRequests = new Map<string, AbortController>()

export function cancelTranslationRequest(requestId: string): boolean {
  const controller = activeRequests.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
}

function toSegmentInputs(segments: TranscriptSegment[]): SegmentInput[] {
  return segments.map((seg) => ({ segmentId: seg.id, text: seg.editedText ?? seg.text }))
}

export async function buildTranslationPreview(segments: TranscriptSegment[]): Promise<CloudRequestPreview> {
  const inputs = toSegmentInputs(segments)
  const fullText = inputs.map((s) => s.text).join('\n')
  return {
    segmentCount: inputs.length,
    characterCount: fullText.length,
    textPreview: fullText.slice(0, 500),
    // The consent dialog names the service the text is about to go to.
    model: (await chooseEngine()) === 'gemini' ? GEMINI_TRANSLATION_MODEL : provider.model
  }
}

async function requireApiKey(): Promise<string> {
  const apiKey = await getApiKey()
  if (!apiKey) {
    throw new ProviderError('auth', 'No Anthropic API key is saved. Add one in AI Suggestions settings first.')
  }
  return apiKey
}

export async function translateSubtitles(requestId: string, segments: TranscriptSegment[], targetLanguage: string): Promise<TranslateSubtitlesResult> {
  const engine = await chooseEngine()
  const apiKey = engine === 'anthropic' ? await requireApiKey() : ''
  const inputs = toSegmentInputs(segments)
  const requestedIds = new Set(inputs.map((s) => s.segmentId))

  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    const results: TranslationResult[] =
      engine === 'gemini'
        ? await translateSegmentsWithGemini(inputs, targetLanguage, controller.signal)
        : await provider.translateSegments(apiKey, inputs, targetLanguage, controller.signal)
    const foundIds = new Set(results.map((r) => r.segmentId))
    const missingSegmentIds = [...requestedIds].filter((id) => !foundIds.has(id))
    return { translations: results, missingSegmentIds }
  } finally {
    activeRequests.delete(requestId)
  }
}

export { ProviderError }
