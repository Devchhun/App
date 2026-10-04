// Auto SRT's pure steps -- the Gemini prompt, reading its answer, repairing
// and cleaning the lines, placing a part's lines in the whole video -- used
// by the desktop's speakerDiarizationService and by the Android app, which
// sends the same audio parts to the same API.
import { parseSrtToSegments } from './srt'
import type { SpeakerGender } from './transcription'

/** Each audio part's own length, and the context heard on both sides of it. */
export const CHUNK_CORE_SECONDS = 60
export const CHUNK_CONTEXT_SECONDS = 2

export interface GeminiLine {
  startTime: number
  endTime: number
  verbatimText: string
  speakerNumber: number
  language: string
  transcriptionConfidence: number
  identityConfidence: number
  /** Gemini's ear for this line's voice (the VOICE column). Combined with
   * the pitch rule per speaker -- see combineSpeakerGender. */
  voice?: SpeakerGender
  /** VOICE marked with *: an inner voice (thought), see shared/innerVoice.ts. */
  innerVoice?: boolean
}
export function cleanGeminiSrt(text: string): string {
  const cleaned = text.trim().replace(/^```(?:srt|subrip|text)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (!cleaned || /^NO_SPEECH\.?$/i.test(cleaned)) return ''
  return cleaned
}
export function buildGeminiTimedTranscriptPrompt(language: string, chunkDurationSeconds: number): string {
  return `Transcribe every spoken utterance in this ${chunkDurationSeconds.toFixed(3)}-second audio file.

Return ONLY plain text rows in this exact format:
START_SECONDS<TAB>END_SECONDS<TAB>VOICE<TAB>EXACT_SPOKEN_TEXT

Example:
1.360\t2.920\tM\t你好
3.200\t4.800\tF\t你去哪里

RULES:
- START_SECONDS and END_SECONDS are decimal seconds relative to this audio file, whose first sample is 0.000.
- VOICE is the voice of that line as you hear it: M = a man (also when he shouts, cries or is angry), F = a woman, U = unsure (a child, overlapping voices, too short to tell). Judge the whole voice, not only how high it is.
- Add * right after VOICE (M*, F*, U*) when the line is a character's INNER VOICE -- a thought heard as a voice-over, not spoken aloud, usually with an echo or reverb on it. Ordinary speech gets no *.
- Include every audible spoken utterance exactly once, chronologically.
- Audio is the only source. Preserve the exact language and words actually spoken.
- Recognition hint: ${language === 'auto' ? 'auto-detect' : language}; if it conflicts with the audio, follow the audio.
- Never translate, summarize, paraphrase, add recap/narration, describe actions/scenes, add speaker names, or invent speech.
- Do not output JSON, SRT numbering, Markdown fences, headings, notes, or explanations.
- Do not transcribe singing (theme songs, sung lyrics over music) -- only spoken dialogue, narration and inner voice.
- If the speech is Chinese, write it in Simplified Chinese characters.
- Silent sections produce no row. If there is no speech, output exactly NO_SPEECH.`
}

/** Reads one timestamp as seconds. Gemini is asked for plain decimal seconds
 * ("61.360"), but with thinking off it often falls back to its native audio
 * clock format ("01:01.360", "0:01:01,360") -- which used to match nothing,
 * so a perfectly good transcript was rejected as "no timestamped dialogue". */
export function parseTimestampSeconds(token: string): number {
  // "1.02.400" -- minutes.seconds.milliseconds, seen in real answers.
  const dotted = /^(\d+)\.(\d{2})\.(\d+)$/.exec(token.trim())
  if (dotted) return Number(dotted[1]) * 60 + Number(`${dotted[2]}.${dotted[3]}`)
  const parts = token.trim().replace(',', '.').split(':')
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return Number.NaN
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

// The lookahead stops a timestamp from giving back its own last digits as
// "text": without it the SRT timing line "00:00:01,100 --> 00:00:02,300"
// read as a row whose dialogue was "00".
const TIMESTAMP = String.raw`\d+\.\d{2}\.\d+(?![\d.,]|:\d)|\d+(?::\d{1,2}){0,2}(?:[.,]\d+)?(?![\d.,]|:\d)`
const TIMED_ROW = new RegExp(String.raw`^\s*(?:\d+[.)]\s+)?[\[(]?\s*(${TIMESTAMP})\s*(?:\t|\||-->|-|–|—|to)\s*(${TIMESTAMP})\s*[\])]?\s*(?:\t|\||:|-)?\s*(.+?)\s*$`, 'i')

const LEADING_VOICE = /^\s*(M|F|U|male|female|unknown|unsure)(\*)?\s*(?:\t|\|)\s*(\d.*)$/i
const VOICE_COLUMN = /^(M|F|U|male|female|unknown|unsure|\?)(\*)?\s*(?:\t|\|)\s*(.+)$/i

const VOICE_COLUMN_LAST = /^(.+?)\s*(?:\t|\|)\s*(M|F|U|male|female|unknown|unsure|\?)(\*)?$/i

function voiceOf(token: string): SpeakerGender {
  const t = token.toLowerCase()
  return t === 'm' || t === 'male' ? 'male' : t === 'f' || t === 'female' ? 'female' : 'unknown'
}

export function parseGeminiTimedTranscript(text: string): GeminiLine[] {
  const cleaned = text.trim().replace(/^```(?:text|tsv)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (!cleaned || /^NO_SPEECH\.?$/i.test(cleaned)) return []
  const lines: GeminiLine[] = []
  for (const rawRow of cleaned.split(/\r?\n/)) {
    // The VOICE column put FIRST ("M<TAB>1.36<TAB>2.92<TAB>text"): moved
    // behind the text, where it is read like any other. The timestamp
    // pattern needs the row to start with a time -- such rows were
    // silently dropped, lines missing from the SRT.
    const leadingVoice = LEADING_VOICE.exec(rawRow)
    const row = leadingVoice ? `${leadingVoice[3]}\t${leadingVoice[1]}${leadingVoice[2] ?? ''}` : rawRow
    const match = row.match(TIMED_ROW)
    if (!match) continue
    const startTime = parseTimestampSeconds(match[1])
    const endTime = parseTimestampSeconds(match[2])
    // The VOICE column, when Gemini gave one: "M<TAB>text" / "F | text".
    // Also after the text ("你好<TAB>M"): left in, that letter would be
    // spoken by the dub.
    const cell = match[3].trim()
    const before = VOICE_COLUMN.exec(cell)
    const after = before ? null : VOICE_COLUMN_LAST.exec(cell)
    const verbatimText = (before ? before[3] : after ? after[1] : cell).trim()
    const voice = before ? voiceOf(before[1]) : after ? voiceOf(after[2]) : undefined
    // "M*": the character's inner voice (a thought, usually echoed).
    const innerVoice = before ? !!before[2] : after ? !!after[3] : false
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || !verbatimText) continue
    lines.push({ startTime, endTime, verbatimText, speakerNumber: 1, language: 'auto', transcriptionConfidence: 1, identityConfidence: 0, ...(voice ? { voice } : {}), ...(innerVoice ? { innerVoice } : {}) })
  }
  if (lines.length > 0) return lines.sort((left, right) => left.startTime - right.startTime)

  // Be tolerant when a model revision returns ordinary SRT despite the TSV
  // request. The app still owns final numbering and absolute timestamps.
  const parsedSrt = parseSrtToSegments(cleanGeminiSrt(cleaned))
  return parsedSrt.segments.map((segment) => ({
    startTime: segment.startTime,
    endTime: segment.endTime,
    verbatimText: segment.text,
    speakerNumber: 1,
    language: segment.language,
    transcriptionConfidence: 1,
    identityConfidence: 0
  }))
}
/** What a part's lines must pass before they are kept:
 * - a repetition loop ("啊!" 69 times, one every half second -- measured on
 *   a real fallback answer) keeps its first line only;
 * - a line timed past the part's end (a nonsense "00:01:59" in a 64 s part)
 *   is dropped;
 * - inner-voice marks on most of the part are implausible (measured: every
 *   line of ordinary dialogue marked M*) and are dropped, so ordinary lines
 *   never get the thought echo;
 * - a row that is not speech at all is dropped: "NO_SPEECH" written as a
 *   row's text (measured: 27 such rows in one real minute, each a subtitle),
 *   or only a sound tag / music note ("[音乐]", "(sighs)", "♪"). */
/** Every line squeezed into the first few percent of a part of real
 * length: the times were written in some other unit ("0.584" for 58.4 s),
 * not as seconds. Measured on a real Khmer episode, three whole minutes. */
export function timesLookCompressed(lines: { endTime: number }[], durationSeconds: number): boolean {
  // Five or more: three quick words ("走! 走! 走!") at a part's start are real.
  if (lines.length < 5 || durationSeconds < 20) return false
  return Math.max(...lines.map((line) => line.endTime)) <= durationSeconds / 20
}

/** Last resort for compressed times (see timesLookCompressed), used only
 * when asking again in SRT form did not give better lines. Read as a
 * hundred times too small -- "0.584" for 58.4 s -- with the odd one as
 * minutes.seconds ("1.040" for 1:04.0); when some time fits neither, the
 * whole part is stretched in proportion so its last line ends at the end. */
export function repairMinuteSecondTimes<T extends { startTime: number; endTime: number }>(lines: T[], durationSeconds: number): T[] {
  if (!timesLookCompressed(lines, durationSeconds)) return lines
  const latest = Math.max(...lines.map((line) => line.endTime))
  const limit = durationSeconds + 2
  const reread = (value: number): number | null => {
    const scaled = Math.round(value * 1000) / 10
    if (scaled <= limit) return scaled
    const minutes = Math.floor(value + 1e-9)
    const seconds = Math.round((value - minutes) * 1000) / 10
    const minuteSeconds = minutes * 60 + seconds
    return seconds < 60 && minuteSeconds <= limit ? minuteSeconds : null
  }
  const repaired: T[] = []
  for (const line of lines) {
    const startTime = reread(line.startTime)
    const endTime = reread(line.endTime)
    if (startTime === null || endTime === null) {
      const scale = latest > 0 ? durationSeconds / latest : 1
      return lines.map((l) => ({ ...l, startTime: l.startTime * scale, endTime: l.endTime * scale }))
    }
    repaired.push({ ...line, startTime, endTime })
  }
  return repaired
}

const NOT_SPEECH_ROW = /^\s*(?:NO[_ ]?SPEECH|\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】|[♪♫\s]+)\s*[.。]?\s*$/i

export function cleanPartLines(lines: GeminiLine[], durationSeconds: number): GeminiLine[] {
  lines = repairMinuteSecondTimes(lines, durationSeconds)
  const kept: GeminiLine[] = []
  let runText = ''
  let runLength = 0
  for (const line of lines) {
    if (line.startTime > durationSeconds + 1) continue
    if (NOT_SPEECH_ROW.test(line.verbatimText)) continue
    // A lone letter ("M") is the voice column leaking into the text.
    if (LONE_LETTER_ROW.test(line.verbatimText)) continue
    const text = line.verbatimText.replace(/[\s\p{P}]/gu, '')
    runLength = text === runText ? runLength + 1 : 1
    runText = text
    // The 2nd and 3rd repeat can be real ("走! 走! 走!"); from the 4th on it is a loop.
    if (runLength <= 3) kept.push(line)
  }
  // A loop is a loop: drop its first three too when it went on and on.
  const cleaned = kept.filter((line, i) => {
    const text = line.verbatimText.replace(/[\s\p{P}]/gu, '')
    const total = lines.filter((l) => l.verbatimText.replace(/[\s\p{P}]/gu, '') === text).length
    return !(total >= 8 && text.length <= 3) || kept.findIndex((l) => l.verbatimText.replace(/[\s\p{P}]/gu, '') === text) === i
  })
  const fitted = cleaned.map(fitOverlongLine)
  const marked = fitted.filter((line) => line.innerVoice).length
  if (fitted.length >= 4 && marked / fitted.length > 0.6) return fitted.map(({ innerVoice: _drop, ...line }) => line)
  return fitted
}

const LONE_LETTER_ROW = /^\s*[A-Za-z]\s*[.。!！]?\s*$/

/** A few words stretched over the music after them (measured: "Oh!" held
 * for 63 s, 119-182 s) end where they could have been said, and are marked
 * for review. */
export function fitOverlongLine<T extends { startTime: number; endTime: number; verbatimText: string; transcriptionConfidence?: number }>(line: T): T {
  const chars = line.verbatimText.replace(/[\s\p{P}]/gu, '').length
  const seconds = line.endTime - line.startTime
  if (seconds <= 10 || seconds <= chars * 1.5 + 4) return line
  return { ...line, endTime: line.startTime + Math.max(1.5, chars * 0.4 + 1), transcriptionConfidence: Math.min(Number(line.transcriptionConfidence ?? 1), 0.5) }
}

/** Too little for a part this long: nothing at all, or a line or two in
 * a small corner of a part of 40 s or more. Measured on a real episode:
 * a minute of narration came back as one 0.07 s line; another as the same
 * word-per-row stamp 200 times, cleaned down to one line. Such a part is
 * doubted like "no speech" -- asked again, and the better answer kept. */
export function isTooSparse(lines: { startTime: number; endTime: number }[], durationSeconds: number): boolean {
  if (lines.length === 0) return true
  if (durationSeconds < 40 || lines.length > 2) return false
  const covered = Math.max(...lines.map((line) => line.endTime)) - Math.min(...lines.map((line) => line.startTime))
  return covered < durationSeconds * 0.25
}
/** Breaks a long episode into output-safe windows. Each upload includes two
 * seconds of context around its core; midpoint ownership keeps each spoken
 * cue exactly once while still allowing a sentence crossing a boundary to
 * be heard intact. Returned timestamps are restored to source-video time. */
export function restoreChunkLines(
  lines: GeminiLine[],
  sourceStart: number,
  coreStart: number,
  coreEnd: number,
  isLast: boolean
): GeminiLine[] {
  // A part given as ABSOLUTE video times (a line 5 s into part 5 written as
  // 245 s, not 5 s) instead of times in the part it was sent: every line
  // then lands past the part and was dropped -- whole minutes missing from
  // the SRT. Recognised when the lines only fit the part once its start is
  // taken off them, and put back into the part's own time.
  const spanLength = coreEnd - sourceStart + CHUNK_CONTEXT_SECONDS + 0.5
  if (sourceStart > 0 && lines.length > 0) {
    const starts = lines.map((line) => line.startTime).sort((a, b) => a - b)
    const median = starts[Math.floor(starts.length / 2)]
    const fitsAbsolute = lines.every((line) => line.startTime - sourceStart >= -1 && line.endTime - sourceStart <= spanLength + 1)
    if (median > spanLength && fitsAbsolute) lines = lines.map((line) => ({ ...line, startTime: line.startTime - sourceStart, endTime: line.endTime - sourceStart }))
  }
  return lines.flatMap((line) => {
    const absoluteStart = sourceStart + line.startTime
    const absoluteEnd = sourceStart + line.endTime
    const midpoint = (absoluteStart + absoluteEnd) / 2
    if (midpoint < coreStart || (!isLast && midpoint >= coreEnd)) return []
    return [{ ...line, startTime: Math.max(0, absoluteStart), endTime: Math.max(absoluteStart + 0.01, absoluteEnd) }]
  })
}
/** Runs `worker` over 0..count-1 with at most `limit` in flight, keeping the
 * results in index order. The first failure stops new work from starting. */
export async function mapWithConcurrency<T>(count: number, limit: number, worker: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count)
  let next = 0
  let failed = false
  const lane = async (): Promise<void> => {
    while (!failed && next < count) {
      const index = next++
      try {
        results[index] = await worker(index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, lane))
  return results
}
