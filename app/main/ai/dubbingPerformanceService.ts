import { GoogleGenAI } from '@google/genai'
import type { AnalyzePerformanceLine } from '@shared/dubbing'
import {
  DUBBING_EMOTIONS,
  DUBBING_ENERGIES,
  DUBBING_PACES,
  analyzePerformancesByRules,
  buildLineContexts,
  sanitizePerformance,
  type LineContext,
  type LinePerformance
} from '@shared/dubbingPerformance'
import { getGeminiApiKey } from './geminiApiKeyStore'
import { explainGeminiError, isRetryableError, sleepUnlessCanceled } from './geminiErrors'

/** AI Dubber's Emotion + Performance Analyzer. Every subtitle line is sent
 * WITH its context -- the three lines before and after it, who says each,
 * who spoke before and speaks next, narrator or dialogue, how long the line
 * has on screen, its punctuation and any emotion tags ("(យំ)") -- and
 * Gemini answers with one structured performance per line (JSON, never
 * prose). Lines of one batch are analysed together, so a scene's emotion
 * carries from line to line instead of being guessed line by line.
 *
 * Text only: no audio or video is uploaded. Flash, no thinking -- this is
 * reading comprehension over short lines, and it runs on every line. */
export const DUBBING_PERFORMANCE_MODEL = process.env.GEMINI_PERFORMANCE_MODEL?.trim() || 'gemini-2.5-flash'
const BATCH_SIZE = 40
const MAX_OUTPUT_TOKENS = 16384
const MAX_NETWORK_ATTEMPTS = 3

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'emotion', 'emotionIntensity', 'speakingStyle', 'pace', 'energy', 'delivery', 'pauseHints', 'emphasisWords'],
        properties: {
          id: { type: 'string' },
          emotion: { type: 'string', enum: [...DUBBING_EMOTIONS] },
          emotionIntensity: { type: 'integer', minimum: 0, maximum: 100 },
          speakingStyle: { type: 'string' },
          pace: { type: 'string', enum: [...DUBBING_PACES] },
          energy: { type: 'string', enum: [...DUBBING_ENERGIES] },
          delivery: { type: 'string' },
          pauseHints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['after', 'duration'],
              properties: { after: { type: 'string' }, duration: { type: 'string', enum: ['short', 'medium', 'long'] } }
            }
          },
          emphasisWords: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

/** One line as the model sees it. */
export function contextItem(ctx: LineContext): Record<string, unknown> {
  return {
    id: ctx.id,
    speaker: ctx.speaker ?? 'unknown',
    role: ctx.isNarrator ? 'narrator' : 'dialogue',
    previousSpeaker: ctx.previousSpeaker ?? null,
    nextSpeaker: ctx.nextSpeaker ?? null,
    durationSeconds: ctx.durationSeconds,
    punctuation: ctx.punctuation || null,
    emotionTags: ctx.tags,
    previous: ctx.previous.map((n) => `${n.speaker ?? '?'}: ${n.text}`),
    text: ctx.text,
    next: ctx.next.map((n) => `${n.speaker ?? '?'}: ${n.text}`)
  }
}

export function buildPerformancePrompt(contexts: LineContext[]): string {
  return `You direct voice actors dubbing a film or drama. For EVERY line below, decide how it should be performed so it sounds like a real person speaking in the scene -- not like someone reading a script.

Each line comes with its context: the 3 lines before ("previous") and after ("next"), who speaks, who spoke before and speaks next, whether it is narration or dialogue, how many seconds it has on screen, its end punctuation, and any emotion tags written in the subtitle (e.g. "យំ" = crying, "សើច" = laughing, "ស្រែក" = shouting, "ខ្សឹប" = whispering, "ភ័យ" = afraid, "ខឹង" = angry). Tags are strong evidence.

Rules:
- Read the context. Keep emotion continuous across a scene: a speaker in the middle of an argument stays heated; a sad scene stays sad unless something changes it. Change emotion only when the story does.
- emotion: one of ${DUBBING_EMOTIONS.join(', ')}. Use "neutral" for ordinary speech -- do not invent drama. Use "whisper" and "shout" for how loud the line is delivered.
- emotionIntensity 0-100: how strongly (30 = mild, 60 = clear, 85+ = extreme).
- speakingStyle: 2-5 short English words (e.g. "breathy, stunned, hesitant").
- pace: ${DUBBING_PACES.join(', ')}. Fit the time on screen: a long line in a short slot must be fast.
- energy: low, medium or high.
- delivery: one short English sentence on how the line moves (e.g. "start softly, voice trembling, more urgent at the end"). Empty for plain lines.
- pauseHints: at most 2 natural pauses, each after a word copied EXACTLY from the line. Empty when none.
- emphasisWords: at most 3 words copied EXACTLY from the line that carry the stress. Empty when none.
- Narration (role "narrator") is storytelling: usually neutral/serious/calm, more expressive only in dramatic moments.
- Answer every id exactly once. JSON only.

Lines:
${JSON.stringify(contexts.map(contextItem), null, 1)}`
}

export function parsePerformanceResponse(text: string, ids: Set<string>): Record<string, LinePerformance> {
  const out: Record<string, LinePerformance> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return out
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return out
    }
  }
  const lines = (parsed as { lines?: unknown })?.lines
  if (!Array.isArray(lines)) return out
  for (const item of lines) {
    const id = (item as { id?: unknown })?.id
    if (typeof id !== 'string' || !ids.has(id)) continue
    const perf = sanitizePerformance(item, 'ai')
    if (perf) out[id] = perf
  }
  return out
}

/** Analyses every line (with context). A line Gemini skipped gets the local
 * rules analysis instead, so every line always comes back with something.
 * Throws when Gemini can't be used at all (no key, auth, credits, network)
 * -- the caller decides whether to fall back to rules for everything. */
export async function analyzeDubbingPerformance(lines: AnalyzePerformanceLine[], signal: AbortSignal): Promise<Record<string, LinePerformance>> {
  if (lines.length === 0) return {}
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  const contexts = buildLineContexts(lines)
  const result: Record<string, LinePerformance> = {}

  for (let start = 0; start < contexts.length; start += BATCH_SIZE) {
    const batch = contexts.slice(start, start + BATCH_SIZE)
    const ids = new Set(batch.map((c) => c.id))
    let lastError: unknown
    let got: Record<string, LinePerformance> | null = null
    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS && !got; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: DUBBING_PERFORMANCE_MODEL,
          contents: [{ role: 'user', parts: [{ text: buildPerformancePrompt(batch) }] }],
          config: {
            temperature: 0.4,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: 'application/json',
            responseJsonSchema: responseSchema,
            abortSignal: signal
          }
        })
        got = parsePerformanceResponse(response.text || '', ids)
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
        if (attempt >= MAX_NETWORK_ATTEMPTS || !isRetryableError(error)) break
        await sleepUnlessCanceled(attempt === 1 ? 3000 : 8000, signal)
      }
    }
    if (!got) throw new Error(explainGeminiError(lastError))
    Object.assign(result, got)
  }

  const missing = lines.filter((line) => !result[line.id])
  if (missing.length > 0) {
    const fallback = analyzePerformancesByRules(lines)
    for (const line of missing) result[line.id] = fallback[line.id]
  }
  return result
}
