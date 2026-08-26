import { PURPOSE_VALUES } from '@shared/suggestions'
import type { CommunicationPurpose } from '@shared/suggestions'
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
}
