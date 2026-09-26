import { PURPOSE_VALUES } from '@shared/suggestions'
import type { CommunicationPurpose, ScriptTransformMode } from '@shared/suggestions'
import type { TranslationResult } from '@shared/translation'
import { ProviderError, type AiProvider, type SegmentInput, type ClassificationResult } from './AiProvider'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-5'
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

const CLASSIFY_TOOL = {
  name: 'classify_segments',
  description:
    'Classifies each narration segment by its communication purpose and produces a short visual phrase for on-screen display.',
  input_schema: {
    type: 'object' as const,
    properties: {
      results: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            segmentId: { type: 'string' as const },
            purpose: { type: 'string' as const, enum: PURPOSE_VALUES },
            visualText: {
              type: 'string' as const,
              description:
                'A short visual phrase (roughly 2-10 words) capturing the segment for on-screen display. Preserve the original language (Khmer stays Khmer).'
            },
            reason: { type: 'string' as const, description: 'One short sentence explaining why this purpose/phrase was chosen.' },
            confidence: { type: 'number' as const, description: '0 to 1' }
          },
          required: ['segmentId', 'purpose', 'visualText', 'reason', 'confidence']
        }
      }
    },
    required: ['results']
  }
}

const TRANSLATE_TOOL = {
  name: 'translate_segments',
  description: 'Translates each subtitle segment into the requested target language, preserving meaning and natural spoken phrasing.',
  input_schema: {
    type: 'object' as const,
    properties: {
      results: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            segmentId: { type: 'string' as const },
            translated: { type: 'string' as const, description: 'The natural, spoken-language translation of this segment.' }
          },
          required: ['segmentId', 'translated']
        }
      }
    },
    required: ['results']
  }
}

const TRANSFORM_SCRIPT_TOOL = {
  name: 'transform_script',
  description: 'Returns the rewritten or summarized script.',
  input_schema: {
    type: 'object' as const,
    properties: {
      result: { type: 'string' as const, description: 'The full transformed script text, in the same language as the input.' }
    },
    required: ['result']
  }
}

function buildTransformScriptPrompt(text: string, mode: ScriptTransformMode): string {
  const task =
    mode === 'summarize'
      ? 'Summarize the following recap script into a concise version that keeps every key story beat, character name and turning point, in order. Aim for roughly a quarter of the original length.'
      : 'Rewrite the following recap script so it reads smoothly for narration: clear sentences, natural flow, consistent tense, no repetition. Keep every fact, name and story beat; do not add new events.'
  return (
    `${task}\n\n` +
    'Rules: write in the SAME language as the input (Khmer stays Khmer, English stays English, mixed stays mixed). ' +
    'Keep paragraph breaks. Return only the script text.\n\n' +
    `Script:\n${text}`
  )
}

const SIMPLIFY_TOOL = {
  name: 'simplify_text',
  description: 'Rewrites a short visual phrase to be even shorter and simpler while preserving its meaning and language.',
  input_schema: {
    type: 'object' as const,
    properties: {
      simplified: { type: 'string' as const, description: 'The shorter, simpler phrase (aim for 2-6 words).' }
    },
    required: ['simplified']
  }
}

function buildTranslatePrompt(segments: SegmentInput[], targetLanguage: string): string {
  const lines = segments.map((s) => `[${s.segmentId}] ${s.text}`).join('\n')
  return (
    `Translate each of these subtitle lines into ${targetLanguage}, one line per line below. ` +
    'These are spoken dialogue/narration lines from a video, meant to be read aloud by a text-to-speech voice -- ' +
    `translate for natural spoken ${targetLanguage}, not a stiff literal word-for-word rendering. ` +
    'Keep any bracketed/parenthetical stage directions (e.g. "(laughs)") in place, translated or not, exactly where they occur. ' +
    'Use the translate_segments tool to return a translation for every segment listed, in the same order.\n\n' +
    lines
  )
}

function buildClassifyPrompt(segments: SegmentInput[]): string {
  const lines = segments.map((s) => `[${s.segmentId}] ${s.text}`).join('\n')
  return (
    'You are analyzing narration segments from a video (the narration may be in Khmer, English, or mixed) ' +
    'to help an AI motion-graphics editor decide what viewers need to see on screen. ' +
    'For each segment, classify its communication purpose from the allowed list, and write a short visual phrase ' +
    '(not a full repeated sentence) suitable for a brief on-screen graphic. Preserve the original meaning and language. ' +
    'Use the classify_segments tool to return your answer for every segment listed.\n\n' +
    lines
  )
}

/** Combines the caller's signal with an internal request timeout, and
 * reports which one actually fired (needed to tell "user canceled" apart
 * from "timed out" after the fact -- both surface as an aborted fetch). */
function withTimeout(signal: AbortSignal, timeoutMs: number): { combined: AbortSignal; timedOut: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeoutSignal])
  return { combined, timedOut: () => timeoutSignal.aborted && !signal.aborted }
}

async function postToAnthropic(
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ content: Array<{ type: string; input?: Record<string, unknown>; text?: string }> }> {
  const { combined, timedOut } = withTimeout(signal, timeoutMs)

  let response: Response
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(body),
      signal: combined
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal.aborted) throw new ProviderError('canceled', 'Request canceled')
      if (timedOut()) throw new ProviderError('timeout', `Request timed out after ${timeoutMs / 1000}s`)
      throw new ProviderError('canceled', 'Request canceled')
    }
    // fetch() rejects with a plain TypeError for DNS/connection failures (offline, etc).
    throw new ProviderError('network', `Could not reach the Anthropic API (offline or network error): ${(err as Error).message}`)
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    if (response.status === 401) {
      throw new ProviderError('auth', 'Invalid Anthropic API key (401 Unauthorized).')
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
      throw new ProviderError(
        'rate-limit',
        'Rate limited by the Anthropic API (429). Try again shortly.',
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
      )
    }
    throw new ProviderError('unknown', `Anthropic API request failed: ${response.status} ${bodyText.slice(0, 300)}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ProviderError('malformed', 'Anthropic API returned a response that was not valid JSON.')
  }

  if (!data || typeof data !== 'object' || !Array.isArray((data as { content?: unknown }).content)) {
    throw new ProviderError('malformed', 'Anthropic API response was empty or missing a content array.')
  }

  return data as { content: Array<{ type: string; input?: Record<string, unknown>; text?: string }> }
}

function isValidPurpose(value: unknown): value is CommunicationPurpose {
  return typeof value === 'string' && (PURPOSE_VALUES as string[]).includes(value)
}

/** Schema-validates one raw result entry; returns null (and lets the caller
 * count it as dropped) rather than throwing, so one bad entry doesn't
 * invalidate an otherwise-good batch. */
function validateResultEntry(raw: unknown): ClassificationResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.segmentId !== 'string' || r.segmentId.length === 0) return null
  if (!isValidPurpose(r.purpose)) return null
  if (typeof r.visualText !== 'string' || r.visualText.trim().length === 0) return null
  if (typeof r.reason !== 'string') return null
  if (typeof r.confidence !== 'number' || Number.isNaN(r.confidence)) return null
  return {
    segmentId: r.segmentId,
    purpose: r.purpose,
    visualText: r.visualText,
    reason: r.reason,
    confidence: Math.min(1, Math.max(0, r.confidence))
  }
}

/** Schema-validates one raw translation entry; null (dropped) rather than
 * throwing, mirroring validateResultEntry's own "one bad entry doesn't
 * invalidate the batch" discipline. */
function validateTranslationEntry(raw: unknown): TranslationResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.segmentId !== 'string' || r.segmentId.length === 0) return null
  if (typeof r.translated !== 'string' || r.translated.trim().length === 0) return null
  return { segmentId: r.segmentId, translated: r.translated }
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic'
  readonly model = MODEL
  private readonly timeoutMs: number

  constructor(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  async classifySegments(apiKey: string, segments: SegmentInput[], signal: AbortSignal): Promise<ClassificationResult[]> {
    if (segments.length === 0) return []

    const data = await postToAnthropic(
      apiKey,
      {
        model: MODEL,
        max_tokens: 4096,
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'classify_segments' },
        messages: [{ role: 'user', content: buildClassifyPrompt(segments) }]
      },
      signal,
      this.timeoutMs
    )

    const toolUse = data.content.find((block) => block.type === 'tool_use')
    if (!toolUse) {
      throw new ProviderError('schema', 'Anthropic API response did not include the expected tool call.')
    }
    const rawResults = (toolUse.input as { results?: unknown[] } | undefined)?.results
    if (!Array.isArray(rawResults)) {
      throw new ProviderError('schema', 'Anthropic API response was missing the results array.')
    }

    const validated = rawResults.map(validateResultEntry).filter((r): r is ClassificationResult => r !== null)
    if (validated.length === 0 && rawResults.length > 0) {
      throw new ProviderError('schema', 'Anthropic API response contained no valid, schema-conforming results.')
    }
    return validated
  }

  async simplifyText(apiKey: string, text: string, signal: AbortSignal): Promise<string> {
    const data = await postToAnthropic(
      apiKey,
      {
        model: MODEL,
        max_tokens: 512,
        tools: [SIMPLIFY_TOOL],
        tool_choice: { type: 'tool', name: 'simplify_text' },
        messages: [{ role: 'user', content: `Simplify this on-screen visual phrase:\n\n${text}` }]
      },
      signal,
      this.timeoutMs
    )

    const toolUse = data.content.find((block) => block.type === 'tool_use')
    const simplified = (toolUse?.input as { simplified?: unknown } | undefined)?.simplified
    if (typeof simplified !== 'string' || simplified.trim().length === 0) {
      throw new ProviderError('schema', 'Anthropic API response did not include a simplified phrase.')
    }
    return simplified
  }

  async transformScript(apiKey: string, text: string, mode: ScriptTransformMode, signal: AbortSignal): Promise<string> {
    const data = await postToAnthropic(
      apiKey,
      {
        model: MODEL,
        // A rewrite returns the whole script back; a recap script can run
        // to a few thousand words.
        max_tokens: 8192,
        tools: [TRANSFORM_SCRIPT_TOOL],
        tool_choice: { type: 'tool', name: 'transform_script' },
        messages: [{ role: 'user', content: buildTransformScriptPrompt(text, mode) }]
      },
      signal,
      this.timeoutMs
    )

    const toolUse = data.content.find((block) => block.type === 'tool_use')
    const result = (toolUse?.input as { result?: unknown } | undefined)?.result
    if (typeof result !== 'string' || result.trim().length === 0) {
      throw new ProviderError('schema', 'Anthropic API response did not include the transformed script.')
    }
    return result
  }

  async translateSegments(apiKey: string, segments: SegmentInput[], targetLanguage: string, signal: AbortSignal): Promise<TranslationResult[]> {
    if (segments.length === 0) return []

    const data = await postToAnthropic(
      apiKey,
      {
        model: MODEL,
        // Translation output has no other fields to trim (unlike
        // classification's purpose/reason/confidence), and a real SRT can
        // easily carry 200+ lines -- a noticeably larger budget than
        // classifySegments' own 4096 to have real headroom for that.
        max_tokens: 8192,
        tools: [TRANSLATE_TOOL],
        tool_choice: { type: 'tool', name: 'translate_segments' },
        messages: [{ role: 'user', content: buildTranslatePrompt(segments, targetLanguage) }]
      },
      signal,
      this.timeoutMs
    )

    const toolUse = data.content.find((block) => block.type === 'tool_use')
    if (!toolUse) {
      throw new ProviderError('schema', 'Anthropic API response did not include the expected tool call.')
    }
    const rawResults = (toolUse.input as { results?: unknown[] } | undefined)?.results
    if (!Array.isArray(rawResults)) {
      throw new ProviderError('schema', 'Anthropic API response was missing the results array.')
    }

    const validated = rawResults.map(validateTranslationEntry).filter((r): r is TranslationResult => r !== null)
    if (validated.length === 0 && rawResults.length > 0) {
      throw new ProviderError('schema', 'Anthropic API response contained no valid, schema-conforming translations.')
    }
    return validated
  }
}
