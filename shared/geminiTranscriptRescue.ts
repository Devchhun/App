// Auto SRT's second chances: what to do when Gemini's answer for a part cannot
// be trusted as it stands (cut off, a repetition loop, "no speech" over dense
// dialogue). The desktop's speakerDiarizationService uses the pure helpers; the
// Android app also runs transcribeSpan, the same steps over its own API calls.
import { buildGeminiTimedTranscriptPrompt, cleanPartLines, isTooSparse, parseGeminiTimedTranscript, timesLookCompressed, type GeminiLine } from './geminiTranscript'

export const MAX_TRANSCRIPT_TOKENS = 32768

/** The output budget for one span, sized to its length. Real speech costs
 * well under 30 tokens a second even in Khmer (a row of timestamps plus a
 * short line every second or two), so 100 per second is several times what
 * honest dialogue needs. What it does NOT allow is a runaway: on music or a
 * noisy outro the model can write the same line again and again, and with a
 * flat 32k budget that loop ran for minutes before failing -- every time a
 * span was retried or split. Sized like this, a loop stops in seconds. */
export function transcriptTokenBudget(durationSeconds: number): number {
  return Math.min(MAX_TRANSCRIPT_TOKENS, Math.max(2048, Math.ceil(durationSeconds * 100)))
}

const normalizeCue = (text: string): string => text.replace(/[\s.,!?！？。，、…"'“”]+/g, '').toLowerCase()

/** A single subtitle line that never ends: the same short chunk eight or
 * more times in a row ("ha ha ha ha…", a syllable held over music), or a
 * "line" far longer than anyone speaks in one breath. Row-level repetition
 * is caught separately; this is the loop that happens INSIDE one row, which
 * leaves too few rows for that check to see anything. */
const RUNAWAY_ROW = /(.{1,20}?)\1{7,}/u
const MAX_HONEST_ROW_CHARS = 300
export function isRunawayRow(text: string): boolean {
  return text.length > MAX_HONEST_ROW_CHARS || RUNAWAY_ROW.test(text)
}

/** The rows of a cut-off transcript that can be trusted: complete (the last
 * row stopped mid-write), not a runaway, not timed past the audio, not a
 * repeat of a row just before it. Flagged low-confidence, since lines next
 * to a loop are the least reliable, so the editor marks them for review. */
/** Parses a transcript that was cut off by the output budget. The final raw
 * line is where the cut happened -- a half-written row or a bare fragment --
 * so it is left out; every line before it was written in full. (Dropping the
 * last PARSED row instead would throw away a good line whenever the cut
 * landed on a fragment that does not parse as a row at all.) */
function completeRows(text: string): GeminiLine[] {
  const rawLines = text.trimEnd().split(/\r?\n/)
  return parseGeminiTimedTranscript(rawLines.slice(0, -1).join('\n'))
}

function trustworthyRows(text: string, durationSeconds: number): GeminiLine[] {
  const complete = completeRows(text)
  const kept: GeminiLine[] = []
  for (const line of complete) {
    if (line.startTime > durationSeconds + 1 || isRunawayRow(line.verbatimText)) continue
    const key = normalizeCue(line.verbatimText)
    if (!key || kept.slice(-4).some((previous) => normalizeCue(previous.verbatimText) === key)) continue
    const endTime = Math.min(line.endTime, durationSeconds)
    if (endTime <= line.startTime) continue
    kept.push({ ...line, endTime, transcriptionConfidence: Math.min(line.transcriptionConfidence, 0.5) })
  }
  return kept
}

/** A transcript that ran out of budget is either genuinely long (split the
 * audio and try again) or a repetition loop (splitting only loops again).
 * For a loop, keep the honest lines before it. Returns null when the output
 * does not look like a loop, so the caller falls back to splitting. */
export function salvageRunawayTranscript(text: string, durationSeconds: number): GeminiLine[] | null {
  // The runaway check includes the cut-off line: that is usually the loop.
  const rowRunaway = parseGeminiTimedTranscript(text).some((line) => isRunawayRow(line.verbatimText))
  const complete = completeRows(text)
  if (!rowRunaway) {
    if (complete.length < 6) return null
    const tailDistinct = new Set(complete.slice(-10).map((line) => normalizeCue(line.verbatimText))).size
    const pastEnd = complete.filter((line) => line.startTime > durationSeconds + 1).length
    if (tailDistinct > 3 && pastEnd < 3) return null
  }
  return trustworthyRows(text, durationSeconds)
}

/** A salvage that stops this far short of the part's end lost real speech. */
const SALVAGE_SLACK_SECONDS = 20

/** Whether the lines kept before a repetition loop still reach (near) the
 * end of the part. Measured on a real episode: a minute of dense dialogue
 * (27 reference lines) looped after its first few rows, and keeping only
 * those rows lost the rest of the minute -- such a part is halved and each
 * half asked again instead. Parts of SALVAGE_SLACK_SECONDS or less always
 * count as covered, so the halving stops there. */
export function salvageCoversPart(lines: { endTime: number }[], durationSeconds: number): boolean {
  const reached = lines.reduce((max, line) => Math.max(max, line.endTime), 0)
  return reached >= durationSeconds - SALVAGE_SLACK_SECONDS
}

/** Last resort for a span too short to split that still overflowed: keep
 * whatever complete lines are trustworthy -- possibly none, for a few
 * seconds of music -- rather than failing the whole video over it. */
export function salvagePartialTranscript(text: string, durationSeconds: number): GeminiLine[] {
  return trustworthyRows(text, durationSeconds)
}
/** A span shorter than this is not split again: at that point the output is
 * not what is overflowing, and halving forever would just burn quota. */
export const MIN_SPLIT_SECONDS = 12

/** Thrown when the model ran out of output budget mid-transcript, so the
 * caller can split the audio instead of failing the whole job. Carries what
 * the model did write, for the last-resort salvage. */
export class TruncatedTranscriptionError extends Error {
  constructor(readonly partialText = '', message = 'Gemini transcription was truncated for this audio part.') {
    super(message)
    this.name = 'TruncatedTranscriptionError'
  }
}

/** Halves a span, or returns null when it is already short enough that
 * splitting cannot help. */
export function splitSpan(startTime: number, endTime: number, minSeconds = MIN_SPLIT_SECONDS): [number, number] | null {
  if (endTime - startTime <= minSeconds) return null
  return [startTime, (startTime + endTime) / 2]
}

export function buildGeminiSrtPrompt(language: string, chunkDurationSeconds: number): string {
  return `Transcribe the uploaded ${chunkDurationSeconds.toFixed(3)}-second audio as standard SubRip SRT.

STRICT OUTPUT RULES:
- Return raw SRT only. Do not use Markdown fences and do not return JSON.
- Each cue must be: sequential number, HH:MM:SS,mmm --> HH:MM:SS,mmm, then the exact spoken text.
- Timestamps are relative to this uploaded audio file starting at 00:00:00,000.
- Include every audible spoken line exactly once in chronological order.
- Preserve the original spoken language and exact wording. Recognition hint: ${language === 'auto' ? 'auto-detect' : language}; if the hint differs from the audio, follow the audio and never translate it.
- Never translate, summarize, paraphrase, explain, improve, censor, or invent speech.
- Never add story recap, narration, scene/action description, greeting, title, speaker name, gender, age, sound label, or metadata unless those exact words are audibly spoken.
- Silent sections produce no cue. Split different speakers into separate cues.
- Do not transcribe singing (theme songs, sung lyrics over music) -- only spoken dialogue, narration and inner voice.
- If the speech is Chinese, write it in Simplified Chinese characters.
- If there is no speech, return exactly NO_SPEECH.`
}

/** When nothing usable came back, say what DID come back: an empty answer
 * blocked by a safety/recitation filter and a transcript in an unexpected
 * layout need different fixes, and "no timestamped dialogue" alone hides
 * which one it was. */
export function unreadableTranscriptMessage(text: string, finishReason: string): string {
  const reason = finishReason && !/^(STOP|FINISH_REASON_UNSPECIFIED)$/i.test(finishReason) ? ` Gemini stopped with ${finishReason}.` : ''
  const excerpt = text.trim().replace(/\s+/g, ' ').slice(0, 120)
  return `Gemini did not return timestamped dialogue for this audio part.${reason}${excerpt ? ` It returned: "${excerpt}${text.trim().length > 120 ? '…' : ''}"` : ' It returned an empty answer.'}`
}

const TIMED_ROWS_SYSTEM = 'Act only as a literal speech-to-text engine. Return timestamped TSV rows only, never JSON, narration, summaries, visual descriptions, or rewritten scripts.'
const SRT_SYSTEM = 'Act only as a literal speech-to-text engine. Return standard SRT only, never JSON, narration, summaries, visual descriptions, or rewritten scripts.'

export interface SpanRequest {
  prompt: string
  systemInstruction: string
  /** One span's sound, as a base64 WAV. */
  audio: string
  temperature: number
  maxOutputTokens: number
}

export interface SpanTools {
  /** The sound between two file times, as a base64 WAV. */
  readAudio: (start: number, end: number) => Promise<string>
  /** Asks Gemini; waiting out its limits is this function's own business. */
  generate: (request: SpanRequest) => Promise<{ text: string; finishReason: string }>
  /** Whether anything can be heard between two file times. */
  isAudible: (start: number, end: number) => boolean
  /** The same sound at a standard loudness, or null when it cannot be done. */
  normalize: (audio: string) => string | null
}

/** The lines of one span of a file, in seconds from `spanStart`. An answer that
 * cannot be trusted is not kept as it stands:
 * - cut off by the output limit: asked again with some sampling (temperature 0
 *   is how a model gets stuck repeating itself), then split in two;
 * - "no speech" or a line or two from a span with sound in it: asked again at a
 *   standard loudness, then for SRT, then in two halves. Measured on a real
 *   episode, a third of it was lost to such answers. */
export async function transcribeSpan(tools: SpanTools, language: string, spanStart: number, spanEnd: number, halved = false, translateTo?: string): Promise<GeminiLine[]> {
  const duration = spanEnd - spanStart
  const audio = await tools.readAudio(spanStart, spanEnd)
  const audible = (): boolean => tools.isAudible(spanStart, spanEnd)
  const inTwo = async (middle: number, options: boolean): Promise<GeminiLine[]> => {
    const first = await transcribeSpan(tools, language, spanStart, middle, options, translateTo)
    const second = await transcribeSpan(tools, language, middle, spanEnd, options, translateTo)
    const offset = middle - spanStart
    return [...first, ...second.map((line) => ({ ...line, startTime: line.startTime + offset, endTime: line.endTime + offset }))].sort((a, b) => a.startTime - b.startTime)
  }
  try {
    const lines = await transcribeOnce(tools, audio, duration, language, audible, true, translateTo)
    if (!isTooSparse(lines, duration) || halved || duration < 40 || !audible()) return lines
    // Still nothing from a part with sound: the same audio cut differently.
    const halves = await inTwo((spanStart + spanEnd) / 2, true)
    return halves.length > lines.length ? halves : lines
  } catch (error) {
    if (!(error instanceof TruncatedTranscriptionError)) throw error
    const split = splitSpan(spanStart, spanEnd)
    // Too short to split and still unreadable (music, shouting): the lines
    // that can be trusted, rather than failing the whole film over it.
    if (!split) return salvagePartialTranscript(error.partialText, duration)
    return inTwo(split[1], halved)
  }
}

/** `translateTo`: rows carry their translation too (the SRT second opinion
 * does not: its lines are translated afterwards, on their own). */
async function transcribeOnce(tools: SpanTools, audio: string, duration: number, language: string, audible: () => boolean, doubtNoSpeech: boolean, translateTo?: string): Promise<GeminiLine[]> {
  const ask = async (prompt: string, systemInstruction: string): Promise<{ text: string; finishReason: string; salvaged?: GeminiLine[]; partial?: string }> => {
    // A second language in every row: room for it (Khmer costs many tokens).
    const budget = translateTo ? Math.min(MAX_TRANSCRIPT_TOKENS, transcriptTokenBudget(duration) * 3) : transcriptTokenBudget(duration)
    const request = (temperature: number): ReturnType<SpanTools['generate']> => tools.generate({ prompt, systemInstruction, audio, temperature, maxOutputTokens: budget })
    const cutOff = (finishReason: string): boolean => /MAX_TOKENS/i.test(finishReason)
    const first = await request(0)
    if (!cutOff(first.finishReason)) return first
    const retry = await request(0.5)
    if (!cutOff(retry.finishReason)) return retry
    const longer = retry.text.length >= first.text.length ? retry.text : first.text
    // A loop keeps what came before it; a long transcript is worth splitting.
    const salvaged = salvageRunawayTranscript(retry.text, duration) ?? salvageRunawayTranscript(first.text, duration)
    if (salvaged) return { text: '', finishReason: retry.finishReason, salvaged, partial: longer }
    throw new TruncatedTranscriptionError(longer)
  }
  const isNoSpeech = (text: string): boolean => /^\s*NO_SPEECH\.?\s*$/i.test(text)

  const first = await ask(buildGeminiTimedTranscriptPrompt(language, duration, translateTo), translateTo ? TIMED_ROWS_SYSTEM.replace('Return timestamped TSV rows only', `Return timestamped TSV rows only, each with its ${translateTo} translation in the last column`) : TIMED_ROWS_SYSTEM)
  if (first.salvaged) {
    if (!salvageCoversPart(first.salvaged, duration)) throw new TruncatedTranscriptionError(first.partial)
    return first.salvaged
  }
  const firstParsed = parseGeminiTimedTranscript(first.text, !!translateTo)
  const firstLines = cleanPartLines(firstParsed, duration)
  const compressed = timesLookCompressed(firstParsed, duration)
  const firstNoSpeech = isNoSpeech(first.text)
  const sparse = firstLines.length > 0 && isTooSparse(firstLines, duration)
  if (firstLines.length > 0 && !compressed && !sparse) return firstLines
  const doubted = (firstNoSpeech || sparse) && !compressed
  // "No speech" is believed only for a part that really is quiet.
  if (doubted && (!doubtNoSpeech || !audible())) return firstLines
  if (doubted) {
    const normalized = tools.normalize(audio)
    if (normalized) {
      try {
        const retry = await transcribeOnce(tools, normalized, duration, language, audible, false, translateTo)
        if (retry.length > firstLines.length && !isTooSparse(retry, duration)) return retry
      } catch (error) {
        // A limit or a dropped connection is the caller's to handle; anything
        // else falls through to the SRT ask on the original sound.
        if (!(error instanceof TruncatedTranscriptionError) && !/did not return timestamped/.test(String(error))) throw error
      }
    }
  }

  // The rows could not be read: standard SRT is the one layout every model
  // revision produces reliably.
  const second = await ask(buildGeminiSrtPrompt(language, duration), SRT_SYSTEM)
  if (second.salvaged) {
    if (!salvageCoversPart(second.salvaged, duration)) throw new TruncatedTranscriptionError(second.partial)
    return second.salvaged
  }
  const secondParsed = parseGeminiTimedTranscript(second.text)
  const secondLines = cleanPartLines(secondParsed, duration)
  const secondTrusted = secondLines.length > 0 && !timesLookCompressed(secondParsed, duration)
  // Real timestamps beat repaired ones unless they found far fewer lines.
  if (compressed ? secondTrusted && secondLines.length * 2 >= firstLines.length : secondLines.length > firstLines.length) return secondLines
  if (firstLines.length > 0) return firstLines
  if (secondLines.length > 0) return secondLines
  if (isNoSpeech(second.text) || firstNoSpeech) return []
  throw new Error(unreadableTranscriptMessage(second.text || first.text, second.finishReason || first.finishReason))
}

/** The loudness speech is brought to (RMS, of full scale): about -20 dB. */
const TARGET_RMS = 0.1
const MOST_GAIN = 20

/** A 16-bit PCM WAV (base64) brought to a standard loudness, for a second
 * opinion on quiet dialogue; samples past full scale are clipped, which speech
 * recognition takes in its stride. Null for silence or an unreadable file. */
export function normalizeWavBase64(base64: string): string | null {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  if (bytes.length < 12 || binary.slice(0, 4) !== 'RIFF' || binary.slice(8, 12) !== 'WAVE') return null
  let at = 12
  let dataStart = -1
  let dataEnd = -1
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true)
    if (binary.slice(at, at + 4) === 'data') {
      dataStart = at + 8
      dataEnd = Math.min(bytes.length, dataStart + size)
      break
    }
    at += 8 + size + (size % 2)
  }
  if (dataStart < 0 || dataEnd - dataStart < 2) return null
  let sum = 0
  let count = 0
  for (let i = dataStart; i + 1 < dataEnd; i += 2) {
    const sample = view.getInt16(i, true)
    sum += sample * sample
    count += 1
  }
  const rms = Math.sqrt(sum / count) / 32768
  if (rms < 1e-5) return null
  const gain = Math.min(MOST_GAIN, TARGET_RMS / rms)
  for (let i = dataStart; i + 1 < dataEnd; i += 2) {
    view.setInt16(i, Math.max(-32768, Math.min(32767, Math.round(view.getInt16(i, true) * gain))), true)
  }
  let out = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) out += String.fromCharCode(...bytes.subarray(i, i + STEP))
  return btoa(out)
}
