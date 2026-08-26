// Cloud provider for AI Connected Story Visualization -- a distinct
// interface from AiProvider.ts's classification-shaped provider (this
// analyzes a WHOLE transcript into one NarrativeGraph, not per-segment
// results), but copies AnthropicProvider.ts's fetch/timeout/error-mapping
// helpers verbatim since both talk to the same Anthropic Messages API in
// the same tool-use-forced-structured-output way.
import { NARRATIVE_ENTITY_TYPE_VALUES, NARRATIVE_RELATION_TYPE_VALUES, VISUALIZATION_TYPE_VALUES, STORY_BEAT_IMPORTANCE_VALUES, STORY_LIMITS } from '@shared/story'
import { TEMPLATE_ICON_IDS } from '@shared/templates'
import { ProviderError } from './AiProvider'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-5'
const DEFAULT_REQUEST_TIMEOUT_MS = STORY_LIMITS.requestTimeoutMs

export interface StorySegmentInput {
  segmentId: string
  text: string
  startTime: number
  endTime: number
}

const ANALYZE_TOOL = {
  name: 'analyze_narrative',
  description:
    'Analyzes the complete narration transcript and returns a whole-story NarrativeGraph: recurring entities (characters/bodies/artifacts/places/events/concepts/chapters), the relationships between them, and a sequence of story beats -- built from the FULL transcript, never from isolated sentences.',
  input_schema: {
    type: 'object' as const,
    properties: {
      entities: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'string' as const, description: 'A short, stable, kebab-case id, e.g. "entity-wang-lin".' },
            type: { type: 'string' as const, enum: NARRATIVE_ENTITY_TYPE_VALUES },
            canonicalName: { type: 'string' as const },
            aliases: { type: 'array' as const, items: { type: 'string' as const } },
            description: { type: 'string' as const, description: 'One or two sentences, using only information present in the transcript.' },
            firstSegmentId: { type: 'string' as const, description: 'The segmentId where this entity is first mentioned.' },
            color: { type: 'string' as const, description: 'A hex color like #5b8cff, distinct per entity, reused for this entity everywhere.' },
            iconId: { type: 'string' as const, enum: TEMPLATE_ICON_IDS }
          },
          required: ['id', 'type', 'canonicalName', 'aliases', 'description', 'firstSegmentId', 'color']
        }
      },
      relations: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'string' as const },
            fromEntityId: { type: 'string' as const },
            toEntityId: { type: 'string' as const },
            type: { type: 'string' as const, enum: NARRATIVE_RELATION_TYPE_VALUES },
            label: { type: 'string' as const, description: 'A short phrase describing this specific relationship.' },
            segmentIds: { type: 'array' as const, items: { type: 'string' as const } }
          },
          required: ['id', 'fromEntityId', 'toEntityId', 'type', 'label', 'segmentIds']
        }
      },
      beats: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'string' as const },
            startTime: { type: 'number' as const },
            endTime: { type: 'number' as const },
            segmentIds: { type: 'array' as const, items: { type: 'string' as const } },
            title: { type: 'string' as const },
            summary: { type: 'string' as const },
            purpose: { type: 'string' as const, description: 'What this beat accomplishes in the story, in plain words.' },
            entities: { type: 'array' as const, items: { type: 'string' as const }, description: 'Entity ids involved in this beat.' },
            relations: { type: 'array' as const, items: { type: 'string' as const }, description: 'Relation ids explained by this beat.' },
            evidence: { type: 'array' as const, items: { type: 'string' as const }, description: 'Paraphrased chapter/source citations, only if present in the transcript.' },
            recommendedVisualization: { type: 'string' as const, enum: VISUALIZATION_TYPE_VALUES },
            importance: { type: 'string' as const, enum: STORY_BEAT_IMPORTANCE_VALUES }
          },
          required: ['id', 'startTime', 'endTime', 'segmentIds', 'title', 'summary', 'purpose', 'entities', 'relations', 'recommendedVisualization', 'importance']
        }
      },
      chronology: { type: 'array' as const, items: { type: 'string' as const }, description: 'Beat ids in chronological (in-story) order.' },
      centralQuestion: { type: 'string' as const, description: 'The core question this transcript answers, using only the transcript\'s own words/ideas.' },
      finalConclusion: { type: 'string' as const, description: 'The story\'s own conclusion, using only information present in the transcript.' }
    },
    required: ['entities', 'relations', 'beats', 'chronology', 'centralQuestion', 'finalConclusion']
  }
}

const VISUALIZATION_GUIDE = `Available recommendedVisualization values and what each is for:
- central-identity: (re)establish one recurring character's identity (name, origin, "the same X" badge).
- reality-vs-dream: separate real story events from a simulation/dream/calculation.
- body-vs-avatar: two different bodies/forms/roles that belong to ONE identity, shown as equals.
- source-branch: a created-from/split-from/sent-to-past relationship between a source entity and a related-but-distinct entity.
- chapter-evidence: a specific chapter/source citation supporting a claim.
- final-summary: a closing multi-point summary converging on one central identity.`

function buildAnalysisPrompt(segments: StorySegmentInput[]): string {
  const lines = segments.map((s) => `[${s.segmentId} | ${s.startTime.toFixed(1)}s-${s.endTime.toFixed(1)}s] ${s.text}`).join('\n')
  return (
    'You are analyzing the COMPLETE narration transcript of a long-form story explanation video (the narration may be in Khmer, English, or mixed) ' +
    'to help an AI motion-graphics editor build a connected, coherent sequence of visual scenes -- never one unrelated graphic per sentence. ' +
    'Read the ENTIRE transcript below before answering. Identify recurring characters, bodies, artifacts, places, events, concepts, and chapter ' +
    'citations; the relationships between them (e.g. one entity being created from, split from, or the same identity as another); and divide the ' +
    'story into a sequence of meaningful beats, each covering one or more consecutive segments (never split a single coherent idea across many ' +
    'one-sentence beats). Use ONLY information found in the transcript -- do not invent lore, chapter numbers, relationships, or conclusions that ' +
    "are not present in the text. If the transcript doesn't mention a chapter number for a claim, leave evidence empty rather than inventing one.\n\n" +
    'Write every piece of text you generate (canonicalName, description, title, summary, purpose, label, centralQuestion, finalConclusion -- ' +
    'everything) in the SAME language the transcript itself is written in. If the transcript is in Khmer, respond entirely in Khmer -- do not ' +
    'switch to Vietnamese, English, or any other language even if character names resemble a well-known translation convention in another language.\n\n' +
    VISUALIZATION_GUIDE +
    '\n\nUse the analyze_narrative tool to return your answer for the transcript below.\n\n' +
    lines
  )
}

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
): Promise<{ content: Array<{ type: string; input?: Record<string, unknown>; text?: string }>; stop_reason?: string }> {
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

  return data as { content: Array<{ type: string; input?: Record<string, unknown>; text?: string }>; stop_reason?: string }
}

/** Provider-agnostic surface for whole-story narrative analysis -- Anthropic
 * is the only concrete implementation for now, mirroring AiProvider.ts's own
 * doc comment ("this exists so a second provider could be added later
 * without touching storyAnalysisService.ts or the IPC layer"). Returns the
 * RAW tool-use input, unvalidated -- storyAnalysisService.ts runs it through
 * shared/story.ts's validateNarrativeGraph before trusting anything in it. */
export interface StoryAnalysisProviderInterface {
  readonly name: string
  readonly model: string
  analyzeNarrative(apiKey: string, segments: StorySegmentInput[], creativity: number, signal: AbortSignal): Promise<unknown>
}

export class StoryAnalysisProvider implements StoryAnalysisProviderInterface {
  readonly name = 'anthropic'
  readonly model = MODEL
  private readonly timeoutMs: number

  constructor(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  async analyzeNarrative(apiKey: string, segments: StorySegmentInput[], _creativity: number, signal: AbortSignal): Promise<unknown> {
    if (segments.length === 0) {
      throw new ProviderError('malformed', 'No transcript segments to analyze.')
    }

    // NOTE: `temperature` is intentionally NOT sent -- the live Anthropic API
    // rejects it for this model ("`temperature` is deprecated for this
    // model", confirmed against the real API, not just the docs), matching
    // AnthropicProvider.ts's own classify/simplify calls, which also never
    // set it. `_creativity` is kept in the signature for a future model that
    // does support steering it, rather than threading a removal through the
    // service/IPC/preload layers for a parameter with nothing left to do.
    const data = await postToAnthropic(
      apiKey,
      {
        model: MODEL,
        // A rich whole-story analysis (many entities/relations/beats) needs
        // far more output than a single-segment classification call --
        // 8192 was observed live to truncate mid-JSON for an 84-segment
        // transcript, which validateNarrativeGraph then correctly rejected
        // as malformed (missing fields) rather than silently accepting a
        // half-built graph. 16000 gives real headroom while staying well
        // under STORY_LIMITS.maxOutputChars's raw-size safety net.
        max_tokens: 16_000,
        tools: [ANALYZE_TOOL],
        tool_choice: { type: 'tool', name: 'analyze_narrative' },
        messages: [{ role: 'user', content: buildAnalysisPrompt(segments) }]
      },
      signal,
      this.timeoutMs
    )

    const toolUse = data.content.find((block) => block.type === 'tool_use')
    if (!toolUse || !toolUse.input) {
      if (data.stop_reason === 'max_tokens') {
        throw new ProviderError(
          'schema',
          'Anthropic cut the response off for hitting the output token limit before finishing the tool call. Try analyzing a shorter transcript.'
        )
      }
      throw new ProviderError('schema', 'Anthropic API response did not include the expected tool call.')
    }
    if (data.stop_reason === 'max_tokens') {
      throw new ProviderError(
        'schema',
        'Anthropic cut the response off for hitting the output token limit -- the returned graph is likely incomplete. Try analyzing a shorter transcript.'
      )
    }
    return toolUse.input
  }
}
