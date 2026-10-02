import type { DubbingSegmentState, DubbingSpeakerProfile, DubbingEngine } from '@shared/dubbing'
import type { NarrationSpeaker } from '@shared/narration'
import { samePerformance, type LinePerformance } from '@shared/dubbingPerformance'
import { isSavedVoiceId } from './savedVoices'
import { edgeFallbackVoiceId, recommendVoiceId } from './voiceModels'
import { kiriVoiceId, kiriVoiceOf } from '@shared/kiriTts'

/** KiriTTS's built-in Khmer voices a line falls back to by gender. */
export const KIRI_FALLBACK_FEMALE = 'Nita'
export const KIRI_FALLBACK_MALE = 'Chanda'

/** The voice a line is spoken in, most specific choice first:
 *   1. the line's own pick (a card clicked for this line),
 *   2. its speaker's pick (a card clicked for that character),
 *   3. the gender known for the line, else the gender Auto SRT estimated
 *      for its speaker from their pitch,
 *   4. Male Adult as the very last resort.
 * Step 3 used to read only the line's own gender -- which Auto SRT leaves
 * 'unknown' -- so every Auto SRT line without a hand-picked voice fell
 * through to Male Adult, and a dub with five detected speakers came out
 * all male. */
export function resolveLineVoice(
  line: Pick<DubbingSegmentState, 'voiceId' | 'detectedGender'>,
  speaker: Pick<DubbingSpeakerProfile, 'voiceId' | 'gender'> | undefined,
  engine: DubbingEngine,
  /** KiriTTS: the account's copy of a VoxCPM2 voice (its Kiri voice id). */
  kiriCopyOf?: (voiceId: string) => string | undefined
): { voiceId: string; gender: NarrationSpeaker } {
  const gender: NarrationSpeaker = line.detectedGender !== 'unknown' ? line.detectedGender : speaker?.gender ?? 'unknown'
  let voiceId = line.voiceId ?? speaker?.voiceId ?? recommendVoiceId(gender) ?? 'male-adult'
  // Edge TTS cannot clone a recording: a cloned voice falls back to Edge's
  // own Khmer voice of the same gender (see AiDubberContext.generateDubbing).
  if (engine === 'edge-tts' && (voiceId === 'custom-voice' || isSavedVoiceId(voiceId) || kiriVoiceOf(voiceId))) voiceId = edgeFallbackVoiceId(gender)
  // A KiriTTS voice is only the account's: VoxCPM2 speaks the line in its
  // own voice of the same gender (it used to fall to Male Adult).
  if (engine === 'voxcpm2' && kiriVoiceOf(voiceId)) voiceId = recommendVoiceId(gender) ?? 'male-adult'
  // KiriTTS speaks only its own voices (built-in or the account's clones):
  // a VoxCPM2 voice copied to the account speaks as that copy; any other
  // falls back to KiriTTS's Khmer voice of the same gender.
  if (engine === 'kiritts' && !kiriVoiceOf(voiceId)) {
    const copy = kiriCopyOf?.(voiceId)
    voiceId = kiriVoiceId(copy ?? (gender === 'female' ? KIRI_FALLBACK_FEMALE : KIRI_FALLBACK_MALE))
  }
  return { voiceId, gender }
}

export interface PlannedLine {
  id: string
  text: string
  startTime: number
  endTime: number
  voiceId: string
  pitch: number
  speed: number
  volumeDb: number
  performance?: LinePerformance
  takeNonce?: number
  /** A thought: the finished line gets the inner-voice echo. */
  innerVoice?: boolean
}

/** One request to the voice engine: a single line, or several neighbouring
 * lines in the same voice read as ONE continuous take. */
export interface GenerationUnit {
  /** The first line; the generated clip is reported under its id. */
  leaderId: string
  /** The other lines this take also covers, in order (may be empty). */
  memberIds: string[]
  text: string
  voiceId: string
  startTime: number
  endTime: number
  pitch: number
  speed: number
  volumeDb: number
  /** The take's performance (its first line's -- joined lines share it). */
  performance?: LinePerformance
  takeNonce?: number
  innerVoice?: boolean
}

/** Neighbouring lines join only while they are close enough that reading
 * them as one take keeps each within reach of its own moment on screen. */
export const JOIN_MAX_GAP_SECONDS = 0.8
export const JOIN_MAX_SPAN_SECONDS = 12

/** Ends each line with a sentence break unless it already has one, so a
 * joined take pauses between lines instead of running them together. */
export function joinSpokenLines(texts: string[]): string {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index, all) => {
      if (index === all.length - 1 || /[.!?។៕…,，。！？;:]$/u.test(text)) return text
      return /[ក-៿]/u.test(text) ? `${text}។` : `${text}.`
    })
    .join(' ')
}

/** Groups chronologically ordered lines into generation units. Consecutive
 * lines join when they share the voice, the pitch/speed/volume settings and
 * the performance (a take has one of each), sit at most JOIN_MAX_GAP_SECONDS apart, and the
 * whole take stays within JOIN_MAX_SPAN_SECONDS. A separate take per short
 * line is what made dubbing sound choppy: every fragment started and ended
 * on its own, with the voice's natural phrasing reset each time. */
export function planGenerationUnits(lines: PlannedLine[], join = true): GenerationUnit[] {
  const units: GenerationUnit[] = []
  let current: { lines: PlannedLine[] } | null = null
  const flush = (): void => {
    if (!current) return
    const [leader, ...members] = current.lines
    units.push({
      leaderId: leader.id,
      memberIds: members.map((line) => line.id),
      text: joinSpokenLines(current.lines.map((line) => line.text)),
      voiceId: leader.voiceId,
      startTime: leader.startTime,
      endTime: current.lines[current.lines.length - 1].endTime,
      pitch: leader.pitch,
      speed: leader.speed,
      volumeDb: leader.volumeDb,
      performance: leader.performance,
      takeNonce: leader.takeNonce,
      innerVoice: leader.innerVoice
    })
    current = null
  }
  for (const line of lines) {
    const previous = current?.lines[current.lines.length - 1]
    const joins =
      join &&
      previous !== undefined &&
      current !== null &&
      line.voiceId === previous.voiceId &&
      line.pitch === previous.pitch &&
      line.speed === previous.speed &&
      line.volumeDb === previous.volumeDb &&
      // A take has ONE control: an angry line and the calm reply after it
      // are never read as one take.
      samePerformance(line.performance, previous.performance) &&
      (line.takeNonce ?? 0) === (previous.takeNonce ?? 0) &&
      // A thought and the spoken line beside it are two takes: only one of
      // them gets the echo.
      !!line.innerVoice === !!previous.innerVoice &&
      line.startTime - previous.endTime <= JOIN_MAX_GAP_SECONDS &&
      line.endTime - current.lines[0].startTime <= JOIN_MAX_SPAN_SECONDS
    if (!joins) flush()
    if (!current) current = { lines: [] }
    current.lines.push(line)
  }
  flush()
  return units
}

/** The most Auto-Speed will speed a line up. It used to make every line fit
 * exactly, with no limit: a 3 s line in a 1 s slot played at 3x, and past
 * the first minutes of an episode (where overruns pile up) the voice turned
 * into an unclear gabble. Past this a line keeps its natural pace and runs
 * a little late instead (planAutoSync). */
export const AUTO_SPEED_MAX = 1.25

/** Speed-up Auto-Speed gives one clip, or null to leave it as it is: it
 * fits, it would gain too little, or it was already sped up once (pressing
 * Auto-Speed again used to speed the sped-up file again, compounding). */
export function autoSpeedFor(clipSeconds: number, availableSeconds: number, alreadyRefit: boolean): number | null {
  if (alreadyRefit || availableSeconds <= 0) return null
  const needed = clipSeconds / availableSeconds
  if (needed <= 1.02) return null
  return Math.round(Math.min(AUTO_SPEED_MAX, needed) * 1000) / 1000
}

/** Auto-Sync: every line back on its subtitle's start -- but never before
 * the previous line has finished (plus a breath), so two lines never talk
 * over each other. Returns only the clips that move. */
export function planAutoSync(lines: { clipId: string; subtitleStart: number; clipStart: number; clipSeconds: number }[], breathSeconds = 0.05): { clipId: string; startTime: number }[] {
  const moves: { clipId: string; startTime: number }[] = []
  let previousEnd = Number.NEGATIVE_INFINITY
  for (const line of [...lines].sort((a, b) => a.subtitleStart - b.subtitleStart)) {
    const start = Math.max(line.subtitleStart, previousEnd + breathSeconds)
    if (Math.abs(line.clipStart - start) > 0.001) moves.push({ clipId: line.clipId, startTime: Math.round(start * 1000) / 1000 })
    previousEnd = start + line.clipSeconds
  }
  return moves
}
