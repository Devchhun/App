import type { DubbingSegmentState, DubbingSpeakerProfile, DubbingEngine } from '@shared/dubbing'
import type { NarrationSpeaker } from '@shared/narration'
import { isSavedVoiceId } from './savedVoices'
import { edgeFallbackVoiceId, recommendVoiceId } from './voiceModels'

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
  engine: DubbingEngine
): { voiceId: string; gender: NarrationSpeaker } {
  const gender: NarrationSpeaker = line.detectedGender !== 'unknown' ? line.detectedGender : speaker?.gender ?? 'unknown'
  let voiceId = line.voiceId ?? speaker?.voiceId ?? recommendVoiceId(gender) ?? 'male-adult'
  // Edge TTS cannot clone a recording: a cloned voice falls back to Edge's
  // own Khmer voice of the same gender (see AiDubberContext.generateDubbing).
  if (engine === 'edge-tts' && (voiceId === 'custom-voice' || isSavedVoiceId(voiceId))) voiceId = edgeFallbackVoiceId(gender)
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
 * lines join when they share the voice and the pitch/speed/volume settings
 * (a take has one of each), sit at most JOIN_MAX_GAP_SECONDS apart, and the
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
      volumeDb: leader.volumeDb
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
      line.startTime - previous.endTime <= JOIN_MAX_GAP_SECONDS &&
      line.endTime - current.lines[0].startTime <= JOIN_MAX_SPAN_SECONDS
    if (!joins) flush()
    if (!current) current = { lines: [] }
    current.lines.push(line)
  }
  flush()
  return units
}
