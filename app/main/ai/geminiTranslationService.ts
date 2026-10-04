import { GoogleGenAI } from '@google/genai'
import { CanceledError } from '../media/jobRunner'
import { ProviderError, type SegmentInput } from './providers/AiProvider'
import type { ClaudeErrorKind } from '@shared/suggestions'
import type { TranslationResult } from '@shared/translation'
import { getGeminiApiKey } from './geminiApiKeyStore'
import {
  TRANSLATION_BATCH_SIZE,
  buildGeminiTranslatePrompt,
  parseGeminiTranslations,
  translationResponseSchema as responseSchema,
  type TranslatedPair
} from '@shared/geminiTranslate'
// The prompt and its answer's reader are shared with the Android app.
export { TRANSLATION_BATCH_SIZE, buildGeminiTranslatePrompt, parseGeminiTranslations, type TranslatedPair } from '@shared/geminiTranslate'
import { describeError, explainGeminiError, isRetryableError, sleepUnlessCanceled } from './geminiErrors'

/** Subtitle translation through Gemini -- the same "Translate to Khmer"
 * step AnthropicProvider.translateSegments does, for users who only have a
 * Gemini key (the one Auto SRT and Story Narration already use).
 * translationService.ts picks whichever key is present. */
export const GEMINI_TRANSLATION_MODEL = process.env.GEMINI_TRANSLATION_MODEL?.trim() || 'gemini-2.5-flash'
const THINKING_BUDGET = /pro/i.test(GEMINI_TRANSLATION_MODEL) ? 128 : 0
const MAX_OUTPUT_TOKENS = 16384
const MAX_NETWORK_ATTEMPTS = 3
/** Previously translated lines shown with each batch so a name or term is
 * spelled the same way from the first line of the video to the last. */
const CONTEXT_LINES = 8

function errorKind(error: unknown): ClaudeErrorKind {
  const text = describeError(error)
  if (/resource_exhausted|quota|\b429\b|rate.?limit/i.test(text)) return 'rate-limit'
  if (/api key|permission_denied|unauthenticated|\b401\b|\b403\b/i.test(text)) return 'auth'
  if (isRetryableError(error)) return 'network'
  return 'unknown'
}

export async function translateSegmentsWithGemini(
  segments: SegmentInput[],
  targetLanguage: string,
  signal: AbortSignal
): Promise<TranslationResult[]> {
  if (segments.length === 0) return []
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new ProviderError('auth', 'Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })

  const request = async (batch: SegmentInput[], context: TranslatedPair[]): Promise<{ results: TranslationResult[]; truncated: boolean }> => {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: GEMINI_TRANSLATION_MODEL,
          contents: [{ role: 'user', parts: [{ text: buildGeminiTranslatePrompt(batch, targetLanguage, context) }] }],
          config: {
            temperature: 0.3,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingBudget: THINKING_BUDGET },
            responseMimeType: 'application/json',
            responseJsonSchema: responseSchema,
            abortSignal: signal
          }
        })
        const truncated = /MAX_TOKENS/i.test(String(response.candidates?.[0]?.finishReason ?? ''))
        return { results: parseGeminiTranslations(response.text || '', batch), truncated }
      } catch (error) {
        if (error instanceof CanceledError || signal.aborted) throw new ProviderError('canceled', 'Canceled')
        lastError = error
        if (attempt >= MAX_NETWORK_ATTEMPTS || !isRetryableError(error)) break
        await sleepUnlessCanceled(attempt === 1 ? 3000 : 8000, signal).catch(() => { throw new ProviderError('canceled', 'Canceled') })
      }
    }
    throw new ProviderError(errorKind(lastError), explainGeminiError(lastError))
  }

  /** One batch, made whole: an answer cut off by the output limit is split
   * in half and retried; lines the model skipped are asked for once more. */
  const translateBatch = async (batch: SegmentInput[], context: TranslatedPair[]): Promise<TranslationResult[]> => {
    const first = await request(batch, context)
    if (first.truncated && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2)
      const left = await translateBatch(batch.slice(0, middle), context)
      const leftContext = [...context, ...pairsFor(batch.slice(0, middle), left)].slice(-CONTEXT_LINES)
      return [...left, ...(await translateBatch(batch.slice(middle), leftContext))]
    }
    const done = new Set(first.results.map((result) => result.segmentId))
    const missing = batch.filter((segment) => !done.has(segment.segmentId))
    if (missing.length === 0 || missing.length === batch.length) {
      if (missing.length === batch.length && batch.length > 0) {
        // Nothing usable came back at all -- one more try before reporting
        // the whole batch as untranslated.
        const retry = await request(batch, context)
        return retry.results
      }
      return first.results
    }
    const second = await request(missing, context)
    return [...first.results, ...second.results]
  }

  const results: TranslationResult[] = []
  let context: TranslatedPair[] = []
  for (let start = 0; start < segments.length; start += TRANSLATION_BATCH_SIZE) {
    const batch = segments.slice(start, start + TRANSLATION_BATCH_SIZE)
    const translated = await translateBatch(batch, context)
    results.push(...translated)
    context = [...context, ...pairsFor(batch, translated)].slice(-CONTEXT_LINES)
  }
  return results
}

function pairsFor(batch: SegmentInput[], results: TranslationResult[]): TranslatedPair[] {
  const byId = new Map(results.map((result) => [result.segmentId, result.translated]))
  return batch.flatMap((segment) => {
    const translated = byId.get(segment.segmentId)
    return translated ? [{ source: segment.text, translated }] : []
  })
}
