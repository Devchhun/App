import { defaultDubbingSegmentState, type DubbingSegmentState, type DubbingSpeakerProfile } from './dubbing'
import { DUBBING_SRT_MARKER, secondsToSrtTimestamp, transcriptSegmentsToSrt } from './srt'
import type { SpeakerAgeCategory, SpeakerGender, TranscriptSegment } from './transcription'

export { DUBBING_SRT_MARKER }

/** An SRT that remembers its dubbing setup.
 *
 * A plain SRT only carries timing and text, so re-importing one used to
 * throw away everything the AI Dubber knew about each line: which speaker
 * said it, male/female, age, the assigned voice, pitch, speed, volume. This
 * writes a normal SRT -- the dialogue cues are untouched -- plus ONE extra
 * cue holding that setup, with zero length, at the last line's end time:
 *
 *     4
 *     00:06:10,200 --> 00:06:10,200
 *     NOTE creative-ai-editor dubbing v1
 *     {"version":1,"lines":[…],"speakers":{…}}
 *
 * Why a zero-length cue rather than a comment block: SRT has no comment
 * syntax. Measured with ffmpeg (what mpv and many players use to read SRT):
 * a trailing block without a timestamp is glued onto the LAST subtitle's
 * text -- the JSON would appear on screen -- and a leading one makes the
 * whole file unreadable. A cue that starts and ends at the same instant is a
 * valid subtitle that a player can never show (visible while
 * start <= t < end, which is empty). Placed at the last line's end, it does
 * not lengthen anything in an editor either. This app's parseSrtToSegments
 * skips it. Lines are matched back by cue ORDER, since a parsed SRT gets
 * fresh segment ids. */

type AgeGroup = NonNullable<DubbingSegmentState['ageGroup']>

/** One cue's dubbing setup, in cue order. Nothing session-specific
 * (generation status, generated clip ids) -- those belong to one project. */
export interface DubbingSrtLine {
  speakerId?: string
  detectedGender: SpeakerGender
  detectedConfidence?: number
  voiceId?: string
  voiceManuallyAssigned?: boolean
  ageGroup?: AgeGroup
  isNarrator?: boolean
  pitch: number
  speed: number
  volumeDb: number
}

export type DubbingSrtSpeaker = Omit<DubbingSpeakerProfile, 'segmentIds'>

export interface DubbingSrtData {
  version: 1
  lines: DubbingSrtLine[]
  speakers: Record<string, DubbingSrtSpeaker>
}

const GENDERS: SpeakerGender[] = ['male', 'female', 'unknown']
const AGE_CATEGORIES: SpeakerAgeCategory[] = ['child', 'young', 'adult', 'elder', 'unknown']
const AGE_GROUPS: AgeGroup[] = ['child', 'young', 'adult', 'old', 'elder', 'unknown']

/** Writes the SRT for `segments` (their current, possibly translated or
 * edited, text) plus the data block for their dubbing setup. */
export function buildDubbingSrt(
  segments: TranscriptSegment[],
  state: { segments: Record<string, DubbingSegmentState>; speakers: Record<string, DubbingSpeakerProfile> }
): string {
  const lines: DubbingSrtLine[] = segments.map((segment) => {
    const line = state.segments[segment.id] ?? defaultDubbingSegmentState(segment.id)
    return {
      speakerId: line.speakerId ?? segment.speakerId,
      detectedGender: line.detectedGender,
      detectedConfidence: line.detectedConfidence,
      voiceId: line.voiceId,
      voiceManuallyAssigned: line.voiceManuallyAssigned,
      ageGroup: line.ageGroup,
      isNarrator: line.isNarrator,
      pitch: line.pitch,
      speed: line.speed,
      volumeDb: line.volumeDb
    }
  })
  const speakers: Record<string, DubbingSrtSpeaker> = {}
  for (const [id, speaker] of Object.entries(state.speakers)) {
    const { segmentIds: _segmentIds, ...rest } = speaker
    // Voice fingerprints are long float arrays; four decimals keep them
    // useful for matching while keeping the file a sensible size.
    speakers[id] = { ...rest, embedding: (rest.embedding ?? []).map((value) => Math.round(value * 10_000) / 10_000) }
  }
  const data: DubbingSrtData = { version: 1, lines, speakers }
  const at = secondsToSrtTimestamp(segments.reduce((end, segment) => Math.max(end, segment.endTime), 0))
  const dataCue = `${segments.length + 1}\n${at} --> ${at}\n${DUBBING_SRT_MARKER}\n${JSON.stringify(data)}\n`
  return segments.length ? `${transcriptSegmentsToSrt(segments).trimEnd()}\n\n${dataCue}` : dataCue
}

/** Separates the dialogue cues from the data cue. `data` is null for an
 * ordinary SRT, or when the data is damaged -- the cues are still usable. */
export function splitDubbingSrt(text: string): { srtText: string; data: DubbingSrtData | null } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n\s*\n/)
  const dataIndex = blocks.findIndex((block) => block.split('\n').some((line) => line.startsWith(DUBBING_SRT_MARKER)))
  if (dataIndex === -1) return { srtText: text, data: null }
  const srtText = blocks.filter((_block, index) => index !== dataIndex).join('\n\n').trim() + '\n'
  const block = blocks[dataIndex]
  const payload = block.slice(block.indexOf(DUBBING_SRT_MARKER) + DUBBING_SRT_MARKER.length).trim()
  try {
    return { srtText, data: sanitizeData(JSON.parse(payload)) }
  } catch {
    return { srtText, data: null }
  }
}

function finiteOr(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
}

/** The file may have been edited by hand or come from anywhere: keep only
 * well-formed values, within the ranges the Dubber's own controls allow. */
function sanitizeData(raw: unknown): DubbingSrtData | null {
  const value = raw as { version?: unknown; lines?: unknown; speakers?: unknown }
  if (!value || value.version !== 1 || !Array.isArray(value.lines)) return null
  const lines: DubbingSrtLine[] = value.lines.map((item) => {
    const line = (item ?? {}) as Record<string, unknown>
    return {
      speakerId: optionalString(line.speakerId),
      detectedGender: GENDERS.includes(line.detectedGender as SpeakerGender) ? (line.detectedGender as SpeakerGender) : 'unknown',
      detectedConfidence: line.detectedConfidence === undefined ? undefined : finiteOr(line.detectedConfidence, 0, 0, 1),
      voiceId: optionalString(line.voiceId),
      voiceManuallyAssigned: line.voiceManuallyAssigned === true ? true : undefined,
      ageGroup: AGE_GROUPS.includes(line.ageGroup as AgeGroup) ? (line.ageGroup as AgeGroup) : undefined,
      isNarrator: line.isNarrator === true ? true : undefined,
      pitch: finiteOr(line.pitch, 0, -24, 24),
      speed: finiteOr(line.speed, 1, 0.25, 4),
      volumeDb: finiteOr(line.volumeDb, 0, -60, 24)
    }
  })
  const speakers: Record<string, DubbingSrtSpeaker> = {}
  if (value.speakers && typeof value.speakers === 'object') {
    for (const [id, item] of Object.entries(value.speakers as Record<string, unknown>)) {
      const speakerId = optionalString(id)
      const speaker = (item ?? {}) as Record<string, unknown>
      if (!speakerId) continue
      speakers[speakerId] = {
        id: speakerId,
        name: optionalString(speaker.name) ?? speakerId,
        gender: GENDERS.includes(speaker.gender as SpeakerGender) ? (speaker.gender as SpeakerGender) : 'unknown',
        genderConfidence: finiteOr(speaker.genderConfidence, 0, 0, 1),
        ageCategory: AGE_CATEGORIES.includes(speaker.ageCategory as SpeakerAgeCategory) ? (speaker.ageCategory as SpeakerAgeCategory) : 'unknown',
        ageConfidence: finiteOr(speaker.ageConfidence, 0, 0, 1),
        identityConfidence: finiteOr(speaker.identityConfidence, 0, 0, 1),
        embedding: Array.isArray(speaker.embedding) ? speaker.embedding.map((n) => Number(n)).filter(Number.isFinite) : [],
        genderManualOverride: speaker.genderManualOverride === true ? true : undefined,
        ageManualOverride: speaker.ageManualOverride === true ? true : undefined,
        voiceId: optionalString(speaker.voiceId),
        voiceManuallyAssigned: speaker.voiceManuallyAssigned === true ? true : undefined,
        mergedFrom: Array.isArray(speaker.mergedFrom) ? speaker.mergedFrom.map(String) : undefined
      }
    }
  }
  return { version: 1, lines, speakers }
}

/** Rebuilds the Dubber's per-line and per-speaker state for freshly parsed
 * cues, matching lines by order. `mismatch` is set when the file's cue count
 * no longer matches its data (cues added/removed by hand) -- whatever still
 * lines up is restored, the rest starts fresh. */
export function restoreDubbingWorkspace(
  parsedSegments: TranscriptSegment[],
  data: DubbingSrtData
): { segments: Record<string, DubbingSegmentState>; speakers: Record<string, DubbingSpeakerProfile>; speakerIdBySegmentId: Record<string, string>; mismatch: boolean } {
  const segments: Record<string, DubbingSegmentState> = {}
  const speakerIdBySegmentId: Record<string, string> = {}
  const segmentIdsBySpeaker: Record<string, string[]> = {}
  parsedSegments.forEach((segment, index) => {
    const line = data.lines[index]
    if (!line) {
      segments[segment.id] = defaultDubbingSegmentState(segment.id)
      return
    }
    segments[segment.id] = {
      ...defaultDubbingSegmentState(segment.id),
      speakerId: line.speakerId,
      detectedGender: line.detectedGender,
      detectedConfidence: line.detectedConfidence,
      voiceId: line.voiceId,
      voiceManuallyAssigned: line.voiceManuallyAssigned,
      ageGroup: line.ageGroup,
      isNarrator: line.isNarrator,
      pitch: line.pitch,
      speed: line.speed,
      volumeDb: line.volumeDb,
      status: line.voiceId ? 'voice-assigned' : 'pending'
    }
    if (line.speakerId) {
      speakerIdBySegmentId[segment.id] = line.speakerId
      ;(segmentIdsBySpeaker[line.speakerId] ??= []).push(segment.id)
    }
  })
  const speakers: Record<string, DubbingSpeakerProfile> = {}
  for (const [id, speaker] of Object.entries(data.speakers)) {
    speakers[id] = { ...speaker, segmentIds: segmentIdsBySpeaker[id] ?? [] }
  }
  return { segments, speakers, speakerIdBySegmentId, mismatch: data.lines.length !== parsedSegments.length }
}
