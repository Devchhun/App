// Subtitle translation through Gemini, the pure part: the prompt (keys L1,
// L2..., earlier lines for consistent names) and reading the answer back.
// Used by the desktop's geminiTranslationService and by the Android app.
import type { TranslationResult } from './translation'

/** One line to translate. */
export interface SegmentInput {
  segmentId: string
  text: string
}

/** Lines per request. Small enough that one answer can never approach the
 * output limit, large enough that each line has neighbours for context. */
export const TRANSLATION_BATCH_SIZE = 60

export const translationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'text'],
        properties: { key: { type: 'string' }, text: { type: 'string' } }
      }
    }
  }
}

export interface TranslatedPair { source: string; translated: string }

/** Lines go out under short keys (L1, L2, …) rather than the app's segment
 * ids: shorter to echo back, and a key the model mangles simply fails to
 * match instead of landing on the wrong subtitle. */
export function buildGeminiTranslatePrompt(batch: SegmentInput[], targetLanguage: string, context: TranslatedPair[]): string {
  const lines = batch.map((segment, index) => `L${index + 1}\t${segment.text.replace(/\s+/g, ' ').trim()}`).join('\n')
  const earlier = context.length
    ? context.map((pair) => `${pair.source.replace(/\s+/g, ' ').trim()}  =>  ${pair.translated}`).join('\n')
    : '(none -- this is the start of the video)'
  return `Translate these subtitle lines into natural spoken ${targetLanguage} for a voice-over dub of the same video.

RULES:
- Return exactly one entry per input key, using the same key. Never merge, split, skip, reorder, or add lines -- each line is timed to the video and will be spoken in its own slot.
- Keep the meaning, tone and register of each line: a shout stays a shout, a question stays a question, a threat stays a threat. Write what a ${targetLanguage} speaker would really say, not a word-for-word gloss.
- Keep each line short and speakable, close to the length of the original, so it fits the same time slot.
- Write person and place names in ${targetLanguage} script and spell each one the same way every time -- follow the earlier translations below.
- Output only the translation: no notes, explanations, original text, parentheses, quotation marks you were not given, or romanization.
- An interjection or sound ("Ah!", "Hmm") becomes the natural ${targetLanguage} equivalent.
- The lines are consecutive dialogue from one video; use neighbouring lines to resolve who is being addressed and what a short line means.

EARLIER LINES AND THEIR TRANSLATIONS (for consistent names and terms; do not translate these again):
${earlier}

LINES TO TRANSLATE (key<TAB>text):
${lines}`
}

/** Maps the model's answer back onto the batch, keeping only entries whose
 * key matches a line in this batch and whose text is non-empty. */
export function parseGeminiTranslations(text: string, batch: SegmentInput[]): TranslationResult[] {
  let parsed: { translations?: unknown }
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')) as { translations?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(parsed.translations)) return []
  const results: TranslationResult[] = []
  const seen = new Set<string>()
  for (const raw of parsed.translations as Array<{ key?: unknown; text?: unknown }>) {
    const match = /^L(\d+)$/i.exec(String(raw?.key ?? '').trim())
    const index = match ? Number(match[1]) - 1 : -1
    const segment = batch[index]
    const translated = String(raw?.text ?? '').trim()
    if (!segment || !translated || seen.has(segment.segmentId)) continue
    seen.add(segment.segmentId)
    results.push({ segmentId: segment.segmentId, translated })
  }
  return results
}
