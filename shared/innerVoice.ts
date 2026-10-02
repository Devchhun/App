// AI Dubber: lines a character THINKS rather than says -- the inner voice a
// drama plays with an echo/reverb over a closed mouth. Found three ways:
// Gemini's Auto SRT marks them (it hears the voice), subtitle text gives
// some away ("(…)", "OS:", 内心), and the original audio itself -- a line
// with echo fades out slowly after the voice stops and fills the gaps
// between syllables, where a dry line drops straight back to silence.
// Such a line is dubbed with an echo too (see buildDubbingPostFxFilterGraph).

export type InnerVoiceSource = 'gemini' | 'text' | 'echo' | 'manual'

const INNER_VOICE_TAG = String.raw`(?:OS|O\.S\.|内心|心声|心想|內心|心聲|គិតក្នុងចិត្ត|ក្នុងចិត្ត)`
// "(内心) …" / "OS: …" / "(OS): …" -- compiled once: this runs for every
// line on every render of the AI Dubber's line list.
const INNER_VOICE_TAG_RE = new RegExp(String.raw`^(?:[(（]\s*${INNER_VOICE_TAG}\s*[)）]|${INNER_VOICE_TAG}\s*[:：])`, 'iu')
const BRACKETED_LINE_RE = /^[(（][^()（）]+[)）]$/u

/** Subtitle conventions for a thought: the whole line in brackets, or an
 * inner-voice / voice-over tag in front. Narration tags (旁白) are not
 * thoughts and stay out. */
export function innerVoiceFromText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (BRACKETED_LINE_RE.test(t)) return true
  return INNER_VOICE_TAG_RE.test(t)
}

export interface EchoAnalysis {
  /** How long the sound takes to fall away after the voice stops (ms). */
  tailMs: number
  /** How far the quiet moments between syllables stay above the room's own
   * floor, 0 (dips reach the floor: dry) .. 1 (never dips: smeared). */
  fill: number
  /** Speech above the background, dB. Below MIN_SNR_DB nothing is judged. */
  snrDb: number
  /** 0..1; ECHO_SCORE_THRESHOLD and up counts as an inner voice. */
  score: number
}

/** Calibrated on Khmer TTS lines (12 lines x silent/music background):
 * dry lines never scored above 0.06; strong echo, reverb and the app's own
 * inner-voice echo scored 0.3-1.0, mild echo under music lower (missed). */
export const ECHO_SCORE_THRESHOLD = 0.4
const FRAME_SECONDS = 0.01
const MIN_SNR_DB = 12

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -120
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
}

/** 10 ms frame levels in dB for [fromSeconds, toSeconds) of mono samples. */
export function frameLevelsDb(samples: ArrayLike<number>, sampleRate: number, fromSeconds: number, toSeconds: number): number[] {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const first = Math.max(0, Math.floor(fromSeconds * sampleRate))
  const last = Math.min(samples.length, Math.ceil(toSeconds * sampleRate))
  const out: number[] = []
  for (let i = first; i + frame <= last; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j]
    out.push(10 * Math.log10(sum / frame + 1e-12))
  }
  return out
}

/** Echo/reverb on one subtitle line of the ORIGINAL audio. `samples` is the
 * whole track (mono, -1..1); the line is [start, end) in seconds. */
export function analyzeEcho(samples: ArrayLike<number>, sampleRate: number, start: number, end: number): EchoAnalysis {
  // The room without this line: the half second before it.
  const before = frameLevelsDb(samples, sampleRate, Math.max(0, start - 0.6), Math.max(0, start - 0.1))
  // The line plus what follows it. Subtitle times are loose (a cue often
  // ends well after the voice does), so the voice itself is found inside:
  // its first and last loud frame.
  const frames = frameLevelsDb(samples, sampleRate, start, end + 0.9)
  const lineFrames = Math.min(frames.length, Math.round((end + 0.3 - start) / FRAME_SECONDS))
  const speech = frames.slice(0, lineFrames)
  const peak = percentile(speech, 95)
  const floor = before.length >= 10 ? percentile(before, 20) : percentile(speech, 5)
  const snrDb = peak - floor
  if (speech.length < 20 || snrDb < MIN_SNR_DB) return { tailMs: 0, fill: 0, snrDb, score: 0 }

  const loud = peak - 12
  const quiet = Math.max(peak - 30, floor + 4)
  let firstLoud = -1
  let lastLoud = -1
  for (let i = 0; i < lineFrames; i++) {
    if (frames[i] < loud) continue
    if (firstLoud < 0) firstLoud = i
    lastLoud = i
  }
  if (firstLoud < 0 || lastLoud - firstLoud < 10) return { tailMs: 0, fill: 0, snrDb, score: 0 }

  // Tail: from the voice's last loud frame until the level is down near
  // the floor (capped by the 0.9 s looked at).
  let i = lastLoud + 1
  while (i < frames.length && frames[i] > quiet) i++
  const tailMs = (i - lastLoud - 1) * FRAME_SECONDS * 1000

  // Fill: how far the gaps between syllables drop below the voice's peak,
  // within the voice itself. Dry speech drops ~25-30 dB between syllables
  // (or down to the background, when music is louder than that); echo keeps
  // them within ~10-17 dB. Measured against the room the background leaves
  // (at most 32 dB), so music under a dry line does not read as echo.
  // Each gap is judged on its own deepest point, and the typical gap
  // counts: a line with a few long pauses (where even an echo dies away)
  // or a run of words with no pause at all no longer decides it alone.
  const gapDepths: number[] = []
  let gapMin = Infinity
  let gapLength = 0
  for (let f = firstLoud; f <= lastLoud; f++) {
    if (frames[f] < peak - 6) {
      gapMin = Math.min(gapMin, frames[f])
      gapLength++
      continue
    }
    if (gapLength >= 3) gapDepths.push(peak - gapMin)
    gapMin = Infinity
    gapLength = 0
  }
  const depth = gapDepths.length >= 2 ? percentile(gapDepths, 50) : peak - percentile(frames.slice(firstLoud, lastLoud + 1), 25)
  const fill = Math.max(0, Math.min(1, 1 - depth / Math.min(snrDb, 32)))

  // Calibrated on Khmer speech, dry vs echo vs reverb, silent and over
  // music (see innerVoice.test.ts): fill separates them in both; the tail
  // only helps without music, where the background cannot mask it.
  const tailScore = Math.max(0, Math.min(1, (tailMs - 100) / 150))
  const fillScore = Math.max(0, Math.min(1, (fill - 0.25) / 0.3))
  return { tailMs, fill, snrDb, score: Math.round((0.7 * fillScore + 0.3 * tailScore) * 100) / 100 }
}

/** Whether a line is dubbed as an inner voice. A choice made by hand
 * stands; otherwise any detection counts -- Gemini's mark on the
 * transcript line, the subtitle text, or an earlier echo detection. */
export function effectiveInnerVoice(
  state: { innerVoice?: boolean; innerVoiceSource?: InnerVoiceSource } | undefined,
  segment: { innerVoice?: boolean; text: string; editedText?: string }
): boolean {
  if (state?.innerVoiceSource === 'manual') return !!state.innerVoice
  return !!state?.innerVoice || !!segment.innerVoice || innerVoiceFromText(segment.editedText ?? segment.text)
}
