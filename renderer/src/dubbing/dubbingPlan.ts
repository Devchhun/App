import type { DubbingSegmentState, DubbingSpeakerProfile, DubbingEngine } from '@shared/dubbing'
import type { NarrationSpeaker } from '@shared/narration'
import { samePerformance, type LinePerformance } from '@shared/dubbingPerformance'
import { isSavedVoiceId } from './savedVoices'
import { edgeFallbackVoiceId, recommendVoiceId } from './voiceModels'
import { kiriVoiceId, kiriVoiceOf } from '@shared/kiriTts'
import { storyVoiceFor, type StoryVoices } from './storyVoices'

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
  line: Pick<DubbingSegmentState, 'voiceId' | 'detectedGender'> & Partial<Pick<DubbingSegmentState, 'ageGroup'>>,
  speaker: (Pick<DubbingSpeakerProfile, 'voiceId' | 'gender'> & Partial<Pick<DubbingSpeakerProfile, 'ageCategory'>>) | undefined,
  engine: DubbingEngine,
  /** KiriTTS: the account's copy of a VoxCPM2 voice (its Kiri voice id). */
  kiriCopyOf?: (voiceId: string) => string | undefined,
  /** "Two voices for the whole story" picked for this engine: the voice of
   * a line with none of its own, by its gender (unknown -> the man's).
   * Without it such a line fell to the engine's stock voice of its gender
   * -- not the two voices picked for the story. */
  storyVoices?: StoryVoices
): { voiceId: string; gender: NarrationSpeaker } {
  const gender: NarrationSpeaker = line.detectedGender !== 'unknown' ? line.detectedGender : speaker?.gender ?? 'unknown'
  // By gender, and by the character's age where it is set (a child's or
  // an old person's voice, when the story has one).
  const story = storyVoices ? storyVoiceFor(storyVoices, gender, line.ageGroup ?? speaker?.ageCategory) : undefined
  let voiceId = line.voiceId ?? speaker?.voiceId ?? story ?? recommendVoiceId(gender) ?? 'male-adult'
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

/** The genders heard for the lines (voice prints, worked out by itself as
 * soon as the SRT is there), written onto every line that has none yet. A
 * gender a line already has -- picked by hand, or heard before -- is kept,
 * and no voice is changed: Generate takes a line's voice from its gender
 * only where no voice was chosen for it. Null when nothing changes. */
export function withHeardGenders(
  lineIds: string[],
  states: Record<string, DubbingSegmentState | undefined>,
  heard: Record<string, { gender: NarrationSpeaker; confidence: number }>,
  fresh: (lineId: string) => DubbingSegmentState
): Record<string, DubbingSegmentState> | null {
  const segments: Record<string, DubbingSegmentState> = {}
  let changed = false
  for (const id of lineIds) {
    const told = heard[id]
    if (!told || told.gender === 'unknown') continue
    const existing = states[id] ?? fresh(id)
    if (existing.detectedGender !== 'unknown') continue
    segments[id] = { ...existing, detectedGender: told.gender, detectedConfidence: told.confidence }
    changed = true
  }
  return changed ? segments : null
}

/** "Two voices for the whole story": every line gets the man's voice or
 * the woman's, by its gender alone -- age (old, young, child) plays no part.
 * The gender is what was just heard for the line (Detect Gender's voice
 * prints), else the one it already had; a line with neither gets the man's
 * voice and is counted as unknown, to be checked by ear. Lines being
 * generated keep their status; every other line is ready to generate again
 * in its new voice. Pure: the counts are worked out once, here. */
export function assignTwoVoices(
  lineIds: string[],
  states: Record<string, DubbingSegmentState | undefined>,
  heard: Record<string, { gender: NarrationSpeaker; confidence: number }> | null,
  voices: StoryVoices,
  fresh: (lineId: string) => DubbingSegmentState
): { segments: Record<string, DubbingSegmentState>; counts: { male: number; female: number; unknown: number; child: number; old: number } } {
  const counts = { male: 0, female: 0, unknown: 0, child: 0, old: 0 }
  const segments: Record<string, DubbingSegmentState> = {}
  for (const id of lineIds) {
    const existing = states[id] ?? fresh(id)
    const told = heard?.[id]
    const known = told && told.gender !== 'unknown' ? told : undefined
    const gender: NarrationSpeaker = known ? known.gender : existing.detectedGender
    if (gender === 'male' || gender === 'female') counts[gender]++
    else counts.unknown++
    // The character's age (Cast window: Child / Adult / Old) picks a
    // child's or an old person's voice when the story has one.
    const voiceId = storyVoiceFor(voices, gender, existing.ageGroup)
    if (voiceId !== (gender === 'female' ? voices.female : voices.male)) counts[existing.ageGroup === 'child' ? 'child' : 'old']++
    segments[id] = {
      ...existing,
      ...(known ? { detectedGender: known.gender, detectedConfidence: known.confidence } : {}),
      voiceId,
      voiceManuallyAssigned: true,
      status: existing.status === 'generating' ? existing.status : 'voice-assigned'
    }
  }
  return { segments, counts }
}

/** One voice and the lines that speak in it. */
export interface VoiceUsage {
  voiceId: string
  gender: NarrationSpeaker
  segmentIds: string[]
}

/** Which voices the script uses in `engine` and on which lines -- each
 * line by the voice Generate Dubbing would give it (resolveLineVoice), so
 * the count is what will be heard, not only what was picked by hand.
 * The most used voice first; lines stay in script order. */
export function voiceUsage(
  lines: { id: string; state: Pick<DubbingSegmentState, 'voiceId' | 'detectedGender'>; speaker: Pick<DubbingSpeakerProfile, 'voiceId' | 'gender'> | undefined }[],
  engine: DubbingEngine,
  kiriCopyOf?: (voiceId: string) => string | undefined,
  storyVoices?: { male: string; female: string }
): VoiceUsage[] {
  const byVoice = new Map<string, VoiceUsage>()
  for (const line of lines) {
    const { voiceId, gender } = resolveLineVoice(line.state, line.speaker, engine, kiriCopyOf, storyVoices)
    const entry = byVoice.get(voiceId)
    if (entry) entry.segmentIds.push(line.id)
    else byVoice.set(voiceId, { voiceId, gender, segmentIds: [line.id] })
  }
  return [...byVoice.values()].sort((a, b) => b.segmentIds.length - a.segmentIds.length)
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
  /** More voices saying the line together with `voiceId`. */
  together?: string[]
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
  /** More voices saying the take together with `voiceId` (such a take is
   * always one line). */
  together?: string[]
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
      innerVoice: leader.innerVoice,
      ...(leader.together?.length ? { together: leader.together } : {})
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
      // A line said by several voices together is mixed on its own.
      !line.together?.length &&
      !previous.together?.length &&
      line.startTime - previous.endTime <= JOIN_MAX_GAP_SECONDS &&
      line.endTime - current.lines[0].startTime <= JOIN_MAX_SPAN_SECONDS
    if (!joins) flush()
    if (!current) current = { lines: [] }
    current.lines.push(line)
  }
  flush()
  return units
}

export { AUTO_SPEED_MAX, autoSpeedFor, planAutoSync } from '@shared/dubFit'
