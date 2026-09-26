import { app } from 'electron'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { GoogleGenAI, FileState, MediaResolution, ThinkingLevel } from '@google/genai'
import { runFfmpeg, cancelJob, CanceledError } from '../media/jobRunner'
import type {
  StoryBeat,
  StoryBeatKind,
  StoryCharacter,
  StoryOutline,
  StoryOutlineRequest,
  StoryReferenceCharacter,
  StoryScriptRequest,
  VideoStoryNarrationProgress,
  VideoStoryNarrationResult,
  VideoStoryNarrationScene
} from '@shared/videoStoryNarration'
import type { TranscriptSegment } from '@shared/transcription'
import { getGeminiApiKey } from './geminiApiKeyStore'
import { explainGeminiError, isRetryableError, sleepUnlessCanceled } from './geminiErrors'
import { extractCompleteArrayItems } from './geminiVideoNarrationService'

/** Story-first Khmer recap -- how a human recapper works, in three steps:
 *
 *  1. buildStoryOutline: watch the WHOLE video once (low resolution is plenty
 *     for who-did-what) with the full subtitles, and write down the
 *     characters (one Khmer name each, every alias the source uses) and the
 *     story beats in order -- marking the opening teaser/theme and credits so
 *     they are left out, and flashbacks so they are announced.
 *  2. The user reviews that outline -- the cheapest place to fix a wrong
 *     name or event (renderer VideoStoryRecapControls).
 *  3. writeRecapScript: write the whole script in ONE pass from the approved
 *     outline (text only), then check it: leftover Chinese/English is
 *     rewritten, every alias becomes the one Khmer name, repeats go.
 *
 * The previous design narrated each 90 s chunk blind to the rest: measured
 * on a 25-minute episode it opened on the teaser montage, restarted "the
 * story begins" three times, narrated the same events twice at chunk
 * overlaps, left 仙人/哥/小宁 untranslated and swapped who hugged whom. */

const MODEL = process.env.GEMINI_VIDEO_MODEL?.trim() || 'gemini-2.5-flash'
/** The outline is where understanding happens (who is who, who did what),
 * so it runs on the strongest model. Measured on a 25-minute episode against
 * the user's own correct recap (22 key events): gemini-3.1-pro-preview got
 * ~19 right with identities and times correct; gemini-2.5-flash varied run
 * to run between ~14 and ~17 and kept giving one character's nickname to
 * another. Script writing (text only) stays on MODEL. A key that cannot use
 * this model falls back to MODEL (see generateOutline). */
const OUTLINE_MODEL = process.env.GEMINI_OUTLINE_MODEL?.trim() || 'gemini-3.1-pro-preview'

/** An error that means "this key can't use that model" rather than a
 * failure of the request itself. */
export function isModelUnavailableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /\b404\b|not found|no longer available|not available|not supported|unsupported model|permission|PERMISSION_DENIED|\b403\b/i.test(text)
}
/** One upload covers at most this much video, outlined part by part, each
 * part seeing the characters found so far. Measured: a whole 25-minute
 * episode in one request ran into the 65k output limit (MAX_TOKENS) before
 * finishing even one beat -- Khmer text is token-heavy and a long answer is
 * where the model starts to loop. A 12-minute part keeps each answer small. */
const PART_SECONDS = 12 * 60
/** A part that still comes back unusable is split in two (this many levels
 * deep, never below MIN_PART_SECONDS). */
const MAX_PART_SPLIT_DEPTH = 2
const MIN_PART_SECONDS = 150
const MAX_OUTPUT_TOKENS = 65536
const THINKING_BUDGET = 8192
const MAX_NETWORK_ATTEMPTS = 3
const SCRIPT_BATCH_BEATS = 45

const active = new Map<string, AbortController>()
const activeFfmpeg = new Map<string, string>()

export function cancelStoryRecap(jobId: string): boolean {
  const controller = active.get(jobId)
  if (!controller) return false
  controller.abort()
  const ffmpegJobId = activeFfmpeg.get(jobId)
  if (ffmpegJobId) cancelJob(ffmpegJobId)
  return true
}

type Progress = (progress: VideoStoryNarrationProgress) => void

const HAN = /[㐀-鿿豈-﫿]/
const KHMER = /[ក-៿]/

// ---------------------------------------------------------------------------
// Step 1: outline

const outlineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['characters', 'beats'],
  properties: {
    // No maxItems here: Gemini refuses a schema with array length limits
    // (HTTP 400 "too many states for serving", measured). Runaway lists are
    // contained by the short parts and the split-and-retry in
    // buildStoryOutline instead.
    characters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'sourceNames', 'role', 'appearance'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          sourceNames: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          appearance: { type: 'string' }
        }
      }
    },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['firstLine', 'lastLine', 'startTime', 'endTime', 'kind', 'characterIds', 'summary'],
        properties: {
          firstLine: { type: 'integer' },
          lastLine: { type: 'integer' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          kind: { type: 'string', enum: ['story', 'flashback', 'teaser', 'credits'] },
          characterIds: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' }
        }
      }
    }
  }
}

/** Subtitle rows inside [startTime, endTime), timestamped relative to
 * `origin` (0 = the given second). */
export function srtLines(segments: TranscriptSegment[], startTime = 0, endTime = Number.POSITIVE_INFINITY, origin = 0): string {
  const rows = segments
    .filter((segment) => segment.endTime > startTime && segment.startTime < endTime)
    .map((segment) => `[${Math.max(0, segment.startTime - origin).toFixed(1)}-${Math.max(0, segment.endTime - origin).toFixed(1)}] ${(segment.editedText ?? segment.text).replace(/\s+/g, ' ').trim()}`)
  return rows.length ? rows.join('\n') : '(no dialogue)'
}

export function buildOutlinePrompt(args: { partStart: number; partEnd: number; segments: TranscriptSegment[]; characterContext: string; known?: StoryOutline; referenceNames?: string[]; storyTitle?: string }): string {
  const title = cleanText(args.storyTitle ?? '')
  const story = title
    ? `STORY: this video is from "${title}". If you know this story (a drama, series, film or novel), use that knowledge ONLY to recognise who the characters are, their real names and how they are related. Never add, predict or explain events that are not in this video.

`
    : ''
  const references = args.referenceNames?.length
    ? `REFERENCE PHOTOS -- the images attached after the video are faces the user identified, in this order:\n${args.referenceNames.map((name, i) => `Photo ${i + 1} = ${name}`).join('\n')}\nPhotos with the same name are the same person. Recognise these people in the video by these faces (face, hair, build -- not only clothes, which can change), and use exactly these names for them in "name". Never give a photographed character's actions to someone else, or someone else's actions to them.\n\n`
    : ''
  const knownCharacters = args.known?.characters.length
    ? args.known.characters.map((c) => `${c.id} | ${c.name} | aka ${c.sourceNames.join(', ')} | ${c.role}`).join('\n')
    : '(none yet)'
  const lastBeats = args.known?.beats.slice(-4).map((b) => `[${b.startTime.toFixed(0)}-${b.endTime.toFixed(0)}] ${b.summary}`).join('\n') || '(this is the start of the video)'
  const partLength = args.partEnd - args.partStart
  return `You are the research assistant of a professional Khmer movie-recap writer. Watch the attached video together with its subtitles and build the STORY OUTLINE the writer needs BEFORE writing. Understand the whole story first; do not describe shots.

TIMES: the attached video is ${partLength.toFixed(0)} seconds long and starts at 0. Give every beat's startTime/endTime in seconds of THIS attached video (0 to ${partLength.toFixed(0)}), matching what you see and the PART SUBTITLES below, which use the same clock. Beats must be in order and must not overlap.

CHARACTERS
- Every character who matters to the plot. id: short and stable (c1, c2, ...). Keep the ids of characters already known below.
- name: ONE name in Khmer script used for them everywhere in the recap. Transliterate a source name into Khmer script (a Chinese name by its Mandarin reading); an unnamed character gets a short Khmer description (for example "បុរសក្បាលទំពែក").
- sourceNames: every exact string the subtitles use for them -- full name, nickname, childhood name, title, "哥"-style address when it clearly means them. One person under two names (a childhood nickname and a later title) is ONE character.
- Check identities against the WHOLE-STORY SUBTITLES below, not just this part. When a line introduces someone by a formal title and old friends call the same person by a childhood nickname, that nickname belongs to THAT person -- never to whoever happens to be speaking or standing nearby. Work out who each nickname refers to from how people address each other before assigning it.
- role: who they are and only CONFIRMED relationships, in Khmer.
- appearance: how to recognise them on screen, in Khmer, short.

BEATS
- Chronological, covering the whole file. A beat is one story event -- a change in the situation -- usually 10 to 90 seconds. Never one beat per subtitle line; never one beat for several unrelated events.
- firstLine / lastLine: the # numbers of the first and last PART SUBTITLES rows spoken during the beat (0 and 0 for a beat with no dialogue). These anchor the beat in time, so get them exactly right; startTime/endTime are still required for beats without dialogue.
- Outline ONLY what happens in the attached video. The previous part and the whole-story subtitles are there for continuity and identities: never add, repeat or "catch up on" an event that is not in this video.
- kind: "teaser" for an opening montage, preview or theme song that shows scenes out of order before the story starts, and for everything after a "to be continued" card (未完待续 / next-episode preview); "credits" for logos, title cards (the episode or series title shown as text) and opening/ending credits; "flashback" ONLY while the picture shows the past -- the characters visibly younger, or a card such as "N years ago"; the moment the scene returns to the present-day characters it is "story" again, even if they talk about the past; otherwise "story".
- characterIds: who acts in the beat.
- summary, in Khmer, 1-2 short sentences: WHO does WHAT to WHOM and what it means for the story. State outcomes plainly (who passes or fails a test, who is hurt, who kills whom, who leaves). Include a gesture only when it matters to the story (a blow, a push, a hug, an object handed over).
- Attribute every line of dialogue to its real speaker using the picture and the story; the person on screen is not always the one speaking, and inner thoughts are not speech. In a farewell or argument, check each line's speaker separately -- who gives advice, who makes a promise, who entrusts whom to whom.
- A named character acts only where the picture shows THAT person (the face, hair and clothes in their appearance) or the subtitles name them. An unnamed person with similar powers, weapons or clothes is a different character: give them their own entry instead of attributing their actions to a named one.
- Never invent. If it is unclear who did something, say so instead of guessing.
- Khmer text only in name/role/appearance/summary: translate Chinese and English; source strings belong only in sourceNames.

${story}${references}Context from the user (trust it over your own guesses):
${args.characterContext.trim() || '(none)'}

Characters already known from earlier parts of this video:
${knownCharacters}

How the previous part ended:
${lastBeats}

WHOLE-STORY SUBTITLES -- for working out who is who and what things mean only (other parts' events are not in this video; times are of the full episode):
${srtLines(args.segments)}

PART SUBTITLES -- this attached video, on its own clock (0 = its start), numbered:
${numberedPartLines(partSegments(args.segments, args.partStart, args.partEnd), args.partStart)}`
}

/** The subtitle rows inside one part, in order -- the rows the outline's
 * firstLine/lastLine numbers (1-based) refer to. */
export function partSegments(segments: TranscriptSegment[], partStart: number, partEnd: number): TranscriptSegment[] {
  return segments.filter((segment) => segment.startTime >= partStart && segment.startTime < partEnd).sort((a, b) => a.startTime - b.startTime)
}

function numberedPartLines(rows: TranscriptSegment[], origin: number): string {
  if (rows.length === 0) return '(no dialogue)'
  return rows.map((segment, index) => `#${index + 1} [${Math.max(0, segment.startTime - origin).toFixed(1)}-${Math.max(0, segment.endTime - origin).toFixed(1)}] ${(segment.editedText ?? segment.text).replace(/\s+/g, ' ').trim()}`).join('\n')
}

const cleanText = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim()

/** Turns the model's JSON into a clean StoryOutline part (lenient: a cut-off
 * answer keeps its complete characters and beats). */
export function parseOutlinePart(text: string, partStart: number, partEnd: number, rows: TranscriptSegment[] = []): { characters: StoryCharacter[]; beats: StoryBeat[] } {
  let parsed: { characters?: unknown; beats?: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    parsed = { characters: extractCompleteArrayItems(text, 'characters'), beats: extractCompleteArrayItems(text, 'beats') }
  }
  const characters: StoryCharacter[] = (Array.isArray(parsed.characters) ? parsed.characters : []).flatMap((raw) => {
    const c = raw as Record<string, unknown>
    const id = cleanText(c.id)
    const name = cleanText(c.name)
    if (!id || !name) return []
    const sourceNames = Array.isArray(c.sourceNames) ? [...new Set(c.sourceNames.map(cleanText).filter(Boolean))] : []
    return [{ id, name, sourceNames, role: cleanText(c.role), appearance: cleanText(c.appearance) }]
  })
  const kinds: StoryBeatKind[] = ['story', 'flashback', 'teaser', 'credits']
  const beats: StoryBeat[] = (Array.isArray(parsed.beats) ? parsed.beats : []).flatMap((raw) => {
    const b = raw as Record<string, unknown>
    // A beat with dialogue is timed by its subtitle rows: row numbers can't
    // drift, while the model's own seconds did -- measured, the first beats
    // of a part that starts mid-scene all came back at 0-1 s. Without
    // dialogue, the model's seconds on the part's own clock (0 = its start)
    // are used, and the part's position is added here, never by the model.
    const first = Math.round(Number(b.firstLine))
    const last = Math.round(Number(b.lastLine))
    const anchored = first >= 1 && last >= first && last <= rows.length
    const start = anchored ? rows[first - 1].startTime : Math.max(partStart, Math.min(partEnd, partStart + Number(b.startTime)))
    const end = anchored ? Math.max(rows[last - 1].endTime, start + 0.5) : Math.max(start + 0.5, Math.min(partEnd, partStart + Number(b.endTime)))
    const summary = cleanText(b.summary)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !summary) return []
    const kind = kinds.includes(b.kind as StoryBeatKind) ? (b.kind as StoryBeatKind) : 'story'
    const characterIds = Array.isArray(b.characterIds) ? b.characterIds.map(cleanText).filter(Boolean) : []
    return [{ id: '', startTime: start, endTime: end, kind, characterIds, summary, include: kind === 'story' || kind === 'flashback' }]
  })
  // In order, and no beat starting before the previous one ends.
  const ordered = beats.sort((a, b) => a.startTime - b.startTime)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].startTime < ordered[i - 1].endTime) ordered[i - 1] = { ...ordered[i - 1], endTime: Math.max(ordered[i - 1].startTime + 0.5, ordered[i].startTime) }
  }
  return { characters, beats: ordered }
}

/** Joins outline parts: characters by id (a later part may add aliases),
 * beats in time order with stable ids b1, b2, ... */
export function mergeOutlineParts(parts: Array<{ characters: StoryCharacter[]; beats: StoryBeat[] }>, model: string): StoryOutline {
  const byId = new Map<string, StoryCharacter>()
  for (const part of parts) {
    for (const character of part.characters) {
      const existing = byId.get(character.id)
      byId.set(character.id, existing ? { ...existing, sourceNames: [...new Set([...existing.sourceNames, ...character.sourceNames])], role: existing.role || character.role, appearance: existing.appearance || character.appearance } : character)
    }
  }
  const beats = parts.flatMap((part) => part.beats).sort((a, b) => a.startTime - b.startTime).map((beat, index) => ({ ...beat, id: `b${index + 1}` }))
  return { characters: [...byId.values()], beats, model }
}

async function waitForFile(ai: GoogleGenAI, name: string, signal: AbortSignal): Promise<{ uri: string; mimeType: string }> {
  for (;;) {
    if (signal.aborted) throw new CanceledError()
    const file = await ai.files.get({ name })
    if (file.state === FileState.ACTIVE && file.uri) return { uri: file.uri, mimeType: file.mimeType || 'video/mp4' }
    if (file.state === FileState.FAILED) throw new Error(file.error?.message || 'Gemini could not process the uploaded video.')
    await sleepUnlessCanceled(2000, signal)
  }
}

/** Calls Gemini with network retries; returns the answer text and finish
 * reason. */
async function generate(ai: GoogleGenAI, parts: Array<Record<string, unknown>>, schema: object, signal: AbortSignal, withVideo: boolean, model = MODEL): Promise<{ text: string; finishReason: string }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Gemini 3 models set how hard they think by level, not by a
          // token budget.
          thinkingConfig: /^gemini-3/i.test(model) ? { thinkingLevel: ThinkingLevel.HIGH } : { thinkingBudget: THINKING_BUDGET },
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          // Who-did-what needs faces and actions, not fine detail: low
          // resolution fits a whole episode in one request.
          ...(withVideo ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
          abortSignal: signal
        }
      })
      return { text: response.text || '', finishReason: String(response.candidates?.[0]?.finishReason ?? '') }
    } catch (error) {
      if (error instanceof CanceledError || signal.aborted) throw new CanceledError()
      lastError = error
      if (attempt >= MAX_NETWORK_ATTEMPTS || !isRetryableError(error)) break
      await sleepUnlessCanceled(attempt === 1 ? 3000 : 8000, signal)
    }
  }
  throw new Error(explainGeminiError(lastError))
}

const namesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['names'],
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'khmerName', 'latinSpellings'],
        properties: { id: { type: 'string' }, khmerName: { type: 'string' }, latinSpellings: { type: 'array', items: { type: 'string' } } }
      }
    }
  }
}

/** Every character ends up with a Khmer-script name. The outline prompt asks
 * for one, but the model does not always comply (measured: one run returned
 * 谷安 / 小宁 / 雷帝真人 as the names and wrote "Gu An", "Xiaoning" in the
 * summaries). One small text request transliterates the stragglers and
 * lists their Latin spellings, so both the outline and the script can swap
 * every form for the Khmer name. On any failure the outline is kept as is
 * -- the review panel lets the user type the names. */
export async function khmerizeNames(outline: StoryOutline, ask: (prompt: string) => Promise<string>): Promise<StoryOutline> {
  const needs = outline.characters.filter((character) => !KHMER.test(character.name))
  if (needs.length === 0) return outline
  let answer: string
  try {
    answer = await ask(`Write each character's name in Khmer script, the way a Khmer movie-recap narrator says it: a Chinese name by its Mandarin reading (for example 小宁 -> ស៊ាវ នីង), a title or description as short natural Khmer. Also list the Latin-letter spellings of the name (pinyin or English, with and without spaces, e.g. "Xiao Ning", "Xiaoning"). One entry per id.\n\n${needs.map((c) => `${c.id}: ${c.name}${c.sourceNames.length ? ` (also called: ${c.sourceNames.join(', ')})` : ''}${c.role ? ` -- ${c.role}` : ''}`).join('\n')}`)
  } catch {
    return outline
  }
  let entries: Array<{ id?: unknown; khmerName?: unknown; latinSpellings?: unknown }>
  try {
    entries = (JSON.parse(answer) as { names?: typeof entries }).names ?? []
  } catch {
    return outline
  }
  const byId = new Map(entries.map((entry) => [cleanText(entry.id), entry]))
  const characters = outline.characters.map((character) => {
    const entry = byId.get(character.id)
    const khmerName = cleanText(entry?.khmerName)
    if (!entry || !KHMER.test(khmerName)) return character
    const latin = Array.isArray(entry.latinSpellings) ? entry.latinSpellings.map(cleanText).filter(Boolean) : []
    return { ...character, name: khmerName, sourceNames: [...new Set([...character.sourceNames, character.name, ...latin])] }
  })
  return { ...outline, characters, beats: outline.beats.map((beat) => ({ ...beat, summary: applyCanonicalNames(beat.summary, characters) })) }
}

const normalizeName = (name: string): string => name.replace(/\s+/g, '').toLowerCase()

/** The user's reference photos that are usable: a name and an image data
 * URL, at most MAX_REFERENCE_PHOTOS of them. */
const MAX_REFERENCE_PHOTOS = 30
export function validReferences(references: StoryReferenceCharacter[] | undefined): Array<{ name: string; mimeType: string; data: string }> {
  // Two photos of one person are often typed two ways ("ឡី ទី" / "ឡីទី",
  // "Gu An" / "gu an"); labelled differently, Gemini takes them for two
  // people. The first spelling names every photo of that person.
  const spelling = new Map<string, string>()
  return (references ?? []).flatMap((reference) => {
    const typed = cleanText(reference.name)
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(reference.image ?? '')
    if (!typed || !match) return []
    const key = normalizeName(typed)
    if (!spelling.has(key)) spelling.set(key, typed)
    return [{ name: spelling.get(key)!, mimeType: match[1], data: match[2] }]
  }).slice(0, MAX_REFERENCE_PHOTOS)
}

/** Shows each photographed character's face in the outline (matched by
 * name, which the prompt asks the model to keep exactly). */
export function attachReferenceFaces(outline: StoryOutline, references: StoryReferenceCharacter[]): StoryOutline {
  if (references.length === 0) return outline
  const byName = new Map(references.filter((r) => r.image).map((r) => [normalizeName(r.name), r.image]))
  return { ...outline, characters: outline.characters.map((c) => (byName.has(normalizeName(c.name)) ? { ...c, faceImage: byName.get(normalizeName(c.name)) } : c)) }
}

export function planOutlineParts(durationSeconds: number, partSeconds = PART_SECONDS): Array<{ start: number; end: number }> {
  const count = Math.max(1, Math.ceil(durationSeconds / partSeconds))
  const size = durationSeconds / count
  return Array.from({ length: count }, (_, i) => ({ start: i * size, end: i === count - 1 ? durationSeconds : (i + 1) * size }))
}

export async function buildStoryOutline(request: StoryOutlineRequest, onProgress: Progress): Promise<StoryOutline> {
  if (active.has(request.jobId)) throw new Error('A story job with this id is already running.')
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  const workDir = join(app.getPath('temp'), 'creative-ai-story-outline', request.jobId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const report = (phase: VideoStoryNarrationProgress['phase'], percent: number, message: string, part?: { index: number; count: number }): void =>
    onProgress({ jobId: request.jobId, phase, percent: Math.round(percent), message, ...(part ? { currentChunk: part.index + 1, totalChunks: part.count } : {}) })
  try {
    await mkdir(workDir, { recursive: true })
    // Only the stretch of the source the user kept on the Timeline (a clip
    // trimmed past its opening teaser starts later than 0).
    const rangeStart = Math.max(0, Math.min(request.videoDurationSeconds, request.rangeStart ?? 0))
    const rangeEnd = Math.max(rangeStart, Math.min(request.videoDurationSeconds, request.rangeEnd ?? request.videoDurationSeconds))
    const parts = planOutlineParts(rangeEnd - rangeStart).map((part) => ({ start: part.start + rangeStart, end: part.end + rangeStart }))
    const results: Array<{ characters: StoryCharacter[]; beats: StoryBeat[] }> = []
    const minutes = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    // Falls back to MODEL for the rest of the job if this key can't use the
    // outline model (measured: a key told gemini-2.5-pro "is no longer
    // available to new users" with a 404).
    let outlineModel = OUTLINE_MODEL
    // The user's face photos travel with every part, so each part matches
    // faces against the same pictures (text descriptions alone drifted
    // between parts).
    const references = validReferences(request.referenceCharacters)
    const referenceImageParts = references.map((reference) => ({ inlineData: { mimeType: reference.mimeType, data: reference.data } }))

    /** Outlines one stretch of video into `results`. A stretch whose answer
     * is unusable (cut off by the output limit before one whole beat, or
     * empty) is split in two and each half outlined on its own. */
    const outlinePart = async (part: { start: number; end: number }, partInfo: { index: number; count: number }, depth: number): Promise<void> => {
      const base = (partInfo.index / partInfo.count) * 90
      const clipPath = join(workDir, `part-${Math.round(part.start)}-${Math.round(part.end)}.mp4`)
      const ffmpegJobId = `${request.jobId}:part-${Math.round(part.start)}`
      activeFfmpeg.set(request.jobId, ffmpegJobId)
      report('preparing', 2 + base, `Preparing video ${minutes(part.start)}–${minutes(part.end)}…`, partInfo)
      await runFfmpeg(ffmpegJobId, [
        '-y', '-ss', String(part.start), '-i', request.videoPath, '-t', String(part.end - part.start),
        '-map', '0:v:0', '-map', '0:a?', '-vf', 'scale=-2:360,fps=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
        '-c:a', 'aac', '-ac', '1', '-b:a', '48k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', clipPath
      ], { totalDurationSeconds: part.end - part.start, onProgress: (p) => report('preparing', 2 + base + (p / partInfo.count) * 0.2, `Preparing video ${minutes(part.start)}–${minutes(part.end)}…`, partInfo) })
      activeFfmpeg.delete(request.jobId)
      if (controller.signal.aborted) throw new CanceledError()
      report('uploading', 5 + base + 20 / partInfo.count, `Uploading ${minutes(part.start)}–${minutes(part.end)} to Gemini…`, partInfo)
      const uploaded = await ai.files.upload({ file: clipPath, config: { mimeType: 'video/mp4', abortSignal: controller.signal } })
      if (!uploaded.name) throw new Error('Gemini upload did not return a file name.')
      let answer: { text: string; finishReason: string }
      try {
        const file = await waitForFile(ai, uploaded.name, controller.signal)
        report('analyzing', 5 + base + 35 / partInfo.count, `Gemini is watching ${minutes(part.start)}–${minutes(part.end)} and noting characters and events…`, partInfo)
        const known = results.length ? mergeOutlineParts(results, MODEL) : undefined
        const ask = (model: string): Promise<{ text: string; finishReason: string }> => generate(ai, [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          ...referenceImageParts,
          { text: buildOutlinePrompt({ partStart: part.start, partEnd: part.end, segments: request.segments, characterContext: request.characterContext, known, referenceNames: references.map((r) => r.name), storyTitle: request.storyTitle }) }
        ], outlineSchema, controller.signal, true, model)
        try {
          answer = await ask(outlineModel)
        } catch (error) {
          if (controller.signal.aborted || outlineModel === MODEL || !isModelUnavailableError(error)) throw error
          console.warn(`[story-outline] ${outlineModel} unavailable for this key; using ${MODEL}. ${error instanceof Error ? error.message.slice(0, 200) : ''}`)
          outlineModel = MODEL
          report('analyzing', 5 + base + 35 / partInfo.count, `Gemini is watching ${minutes(part.start)}–${minutes(part.end)} (standard model)…`, partInfo)
          answer = await ask(outlineModel)
        }
      } finally {
        await ai.files.delete({ name: uploaded.name }).catch(() => undefined)
        await rm(clipPath, { force: true }).catch(() => undefined)
      }
      const parsed = parseOutlinePart(answer.text, part.start, part.end, partSegments(request.segments, part.start, part.end))
      if (parsed.beats.length > 0) {
        results.push(parsed)
        return
      }
      // Record what came back, so an unusable answer can be diagnosed.
      console.warn(`[story-outline] ${minutes(part.start)}–${minutes(part.end)}: no usable beats (${answer.finishReason || 'no finish reason'}, ${answer.text.length} chars). Began: ${answer.text.slice(0, 400).replace(/\s+/g, ' ')} … Ended: ${answer.text.slice(-300).replace(/\s+/g, ' ')}`)
      const length = part.end - part.start
      if (depth < MAX_PART_SPLIT_DEPTH && length / 2 >= MIN_PART_SECONDS) {
        const middle = part.start + length / 2
        await outlinePart({ start: part.start, end: middle }, partInfo, depth + 1)
        await outlinePart({ start: middle, end: part.end }, partInfo, depth + 1)
        return
      }
      throw new Error(`Gemini returned no story outline for ${minutes(part.start)}–${minutes(part.end)} (${answer.finishReason || 'no finish reason'}). Try again.`)
    }

    for (let index = 0; index < parts.length; index++) await outlinePart(parts[index], { index, count: parts.length }, 0)
    report('merging', 95, 'Writing character names in Khmer…')
    const merged = attachReferenceFaces(mergeOutlineParts(results, outlineModel), request.referenceCharacters ?? [])
    const outline = await khmerizeNames(merged, async (prompt) => (await generate(ai, [{ text: prompt }], namesSchema, controller.signal, false)).text)
    report('complete', 100, 'Story outline ready — review it, then write the script.')
    return outline
  } finally {
    active.delete(request.jobId)
    activeFfmpeg.delete(request.jobId)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Step 3: script

const scriptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['beatId', 'khmerNarration'],
        properties: { beatId: { type: 'string' }, khmerNarration: { type: 'string' } }
      }
    }
  }
}

const STYLE_RULES = `STYLE -- a Khmer movie-recap voice-over, told like a storyteller:
- One paragraph per beat, in the given order, usually 1-3 sentences (up to 5 for a big event). Never one sentence per subtitle line; never a list of what the camera shows.
- Name the acting character first, then the concrete action, then who it affects and what follows: "គូ អាន ប្រញាប់ខ្ទប់មាត់ប្អូនស្រី ហើយនិយាយទៅកាន់..." Repeat the name when two people are in the scene; never an ambiguous "គាត់" then.
- Retell dialogue indirectly (ប្រាប់ថា / សួរថា / ឆ្លើយថា / និយាយថា). Keep at most one short dramatic line per paragraph as a direct quote.
- An inner thought is told as a thought (គិតក្នុងចិត្តថា), never as speech.
- A visible feeling may be told as seen (ឃើញបែបនោះ ក៏ភ័យយ៉ាងខ្លាំង); never invent hidden motives.
- When the story moves to another place or group, start with "សាច់រឿងកាត់មកកន្លែងមួយទៀត។" or "សាច់រឿងកាត់ត្រឡប់មកកាន់ [ឈ្មោះ] វិញ។". A flashback beat starts with "សាច់រឿងកាត់ត្រឡប់ទៅអតីតកាល។"; the first beat after it starts with "សាច់រឿងកាត់ត្រឡប់មកបច្ចុប្បន្នវិញ។". Do not use these inside one continuous scene.
- Natural spoken Khmer. No Chinese characters, no English, no Latin-letter names: every character is called by the Khmer name in the CHARACTERS list, exactly as written there.
- No camera words ("រូបភាពបង្ហាញ", "ឈុតនេះបង្ហាញ"), no clothing/colour inventories, no opinions.`

export function buildScriptPrompt(args: { outline: StoryOutline; beats: StoryBeat[]; segments: TranscriptSegment[]; isFirstBatch: boolean; previousParagraphs: string[] }): string {
  const characters = args.outline.characters.map((c) => `${c.name} -- ${c.role}${c.sourceNames.length ? ` (in the subtitles: ${c.sourceNames.join(', ')})` : ''}`).join('\n')
  const nameOf = new Map(args.outline.characters.map((c) => [c.id, c.name]))
  const beats = args.beats
    .map((b) => `### ${b.id} | ${b.startTime.toFixed(0)}-${b.endTime.toFixed(0)}s | ${b.kind}${b.characterIds.length ? ` | ${b.characterIds.map((id) => nameOf.get(id) ?? id).join(', ')}` : ''}\n${b.summary}\nSubtitles in this beat (for exact meaning only -- do not translate them line by line):\n${srtLines(args.segments, b.startTime, b.endTime)}`)
    .join('\n\n')
  const opening = args.isFirstBatch
    ? 'The FIRST paragraph opens with a short welcome to the viewers (2-3 sentences: greeting, today\'s story is worth watching, let\'s begin) and then "សាច់រឿងចាប់ផ្តើមឡើង ដោយ..." for the first beat. "សាច់រឿងចាប់ផ្តើមឡើង" appears only there, once in the whole script.'
    : 'This continues a script already begun: no welcome, and never "សាច់រឿងចាប់ផ្តើមឡើង" again.'
  return `Write the final Khmer voice-over script of a movie recap from the approved STORY OUTLINE below. The outline is authoritative: follow its characters, events and outcomes; do not add events it does not contain.

Return JSON: one entry per beat below, in the same order, with its beatId and its khmerNarration.

${STYLE_RULES}

${opening}

CHARACTERS (use exactly these Khmer names):
${characters}

${args.previousParagraphs.length ? `The script so far ends like this (continue from it, do not repeat it):\n${args.previousParagraphs.join('\n\n')}\n\n` : ''}BEATS:
${beats}`
}

/** Every alias the source uses becomes the one Khmer name. Latin aliases
 * match whole words only ("An" must not eat "And"); Chinese ones anywhere. */
export function applyCanonicalNames(text: string, characters: StoryCharacter[]): string {
  const replacements = characters
    .flatMap((c) => c.sourceNames.filter((alias) => alias && alias !== c.name && !KHMER.test(alias) && alias.length >= 2).map((alias) => ({ alias, name: c.name })))
    .sort((a, b) => b.alias.length - a.alias.length)
  let out = text
  for (const { alias, name } of replacements) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(HAN.test(alias) ? new RegExp(escaped, 'g') : new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'g'), name)
  }
  return out
}

/** Chinese left behind, or an English word of 3+ letters. */
export function needsKhmerRepair(text: string): boolean {
  return HAN.test(text) || /[A-Za-z]{3,}/.test(text)
}

const RESTART = 'សាច់រឿងចាប់ផ្តើមឡើង'

/** The deterministic checks on a finished script. */
export function finishScript(paragraphs: Array<{ beatId: string; khmerNarration: string }>, characters: StoryCharacter[]): Array<{ beatId: string; khmerNarration: string }> {
  const out: Array<{ beatId: string; khmerNarration: string }> = []
  for (const paragraph of paragraphs) {
    let text = applyCanonicalNames(paragraph.khmerNarration.trim(), characters)
    // "The story begins" belongs to the opening only.
    if (out.length > 0 && text.includes(RESTART)) text = text.replace(new RegExp(`${RESTART}\\s*(ដោយ)?\\s*`), '').trim()
    if (!text) continue
    const previous = out[out.length - 1]
    if (previous && previous.khmerNarration.replace(/\s+/g, '') === text.replace(/\s+/g, '')) continue
    out.push({ beatId: paragraph.beatId, khmerNarration: text })
  }
  return out
}

const repairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repairs'],
  properties: { repairs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['beatId', 'khmerNarration'], properties: { beatId: { type: 'string' }, khmerNarration: { type: 'string' } } } } }
}

export async function writeRecapScript(request: StoryScriptRequest, onProgress: Progress): Promise<VideoStoryNarrationResult> {
  if (active.has(request.jobId)) throw new Error('A story job with this id is already running.')
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  const report = (phase: VideoStoryNarrationProgress['phase'], percent: number, message: string): void => onProgress({ jobId: request.jobId, phase, percent: Math.round(percent), message })
  try {
    const beats = request.outline.beats.filter((beat) => beat.include)
    if (beats.length === 0) throw new Error('No story events are selected in the outline.')
    const batches: StoryBeat[][] = []
    for (let i = 0; i < beats.length; i += SCRIPT_BATCH_BEATS) batches.push(beats.slice(i, i + SCRIPT_BATCH_BEATS))
    const written: Array<{ beatId: string; khmerNarration: string }> = []
    for (let index = 0; index < batches.length; index++) {
      report('analyzing', 5 + (index / batches.length) * 75, `Writing the Khmer script${batches.length > 1 ? ` (part ${index + 1} of ${batches.length})` : ''}…`)
      const batch = batches[index]
      const answer = await generate(ai, [{ text: buildScriptPrompt({ outline: request.outline, beats: batch, segments: request.segments, isFirstBatch: index === 0, previousParagraphs: written.slice(-3).map((p) => p.khmerNarration) }) }], scriptSchema, controller.signal, false)
      let items: unknown[]
      try {
        items = (JSON.parse(answer.text) as { paragraphs?: unknown[] }).paragraphs ?? []
      } catch {
        items = extractCompleteArrayItems(answer.text, 'paragraphs')
      }
      const wanted = new Set(batch.map((beat) => beat.id))
      for (const raw of items) {
        const item = raw as { beatId?: unknown; khmerNarration?: unknown }
        const beatId = cleanText(item.beatId)
        const text = String(item.khmerNarration ?? '').trim()
        if (wanted.has(beatId) && text) written.push({ beatId, khmerNarration: text })
      }
    }

    // Checks: the one Khmer name everywhere, no second "story begins", no
    // repeats -- then anything still carrying Chinese or English is
    // rewritten in Khmer by a small targeted request.
    report('merging', 82, 'Checking names, repeats and language…')
    let paragraphs = finishScript(written, request.outline.characters)
    const needRepair = paragraphs.filter((p) => needsKhmerRepair(p.khmerNarration))
    if (needRepair.length > 0) {
      const names = request.outline.characters.map((c) => `${c.name}${c.sourceNames.length ? ` (= ${c.sourceNames.join(', ')})` : ''}`).join('\n')
      const answer = await generate(ai, [{ text: `Rewrite each paragraph below entirely in natural spoken Khmer. Translate every Chinese or English word or phrase into Khmer and remove the original. Call each character only by the Khmer name given. Keep the meaning, events and order exactly; do not add or drop anything.\n\nCHARACTER NAMES:\n${names}\n\nPARAGRAPHS (JSON):\n${JSON.stringify(needRepair)}` }], repairSchema, controller.signal, false)
      try {
        const repairs = new Map(((JSON.parse(answer.text) as { repairs?: Array<{ beatId: string; khmerNarration: string }> }).repairs ?? []).map((r) => [r.beatId, String(r.khmerNarration ?? '').trim()]))
        paragraphs = finishScript(paragraphs.map((p) => ({ ...p, khmerNarration: repairs.get(p.beatId) || p.khmerNarration })), request.outline.characters)
      } catch {
        // Keep the unrepaired text rather than lose the paragraph.
      }
    }

    const beatById = new Map(request.outline.beats.map((beat) => [beat.id, beat]))
    const scenes: VideoStoryNarrationScene[] = paragraphs.flatMap((p) => {
      const beat = beatById.get(p.beatId)
      if (!beat) return []
      return [{ id: beat.id, startTime: beat.startTime, endTime: beat.endTime, dialogueSummary: beat.summary, visibleAction: '', khmerNarration: p.khmerNarration, confidence: needsKhmerRepair(p.khmerNarration) ? 0.5 : 0.9 }]
    })
    report('complete', 100, 'Script ready.')
    return { scenes, generatedAt: new Date().toISOString(), model: MODEL, sourceSrtFileName: request.sourceSrtFileName }
  } finally {
    active.delete(request.jobId)
  }
}
