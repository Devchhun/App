// AI Dubber Batch Auto SRT: several videos laid end to end on the Timeline
// (episode order), transcribed one at a time, each video's subtitles placed
// on the Timeline under that video. The AI Dubber workspace then holds ONE
// transcript whose times are Timeline times -- captions, dubbing, translate
// and export all work over the whole run of episodes at once.

import type { DetectedSpeakerProfile, TranscriptSegment } from './transcription'
import type { ProjectSequence, TimelineClip } from './project'
import { clipRate } from './clipTiming'

/** One video on the Timeline that Batch Auto SRT works through. */
export interface BatchPart {
  clipId: string
  mediaId: string
  /** Timeline seconds the clip covers. */
  startTime: number
  endTime: number
  /** Where in its own file the clip starts, and its playback rate. */
  sourceIn: number
  rate: number
}

/** The video clips of the main video track in Timeline order -- or, with
 * nothing there, every video clip. */
export function batchPartsOf(sequence: ProjectSequence): BatchPart[] {
  const mainId = sequence.tracks.find((t) => t.isMain && t.kind === 'video')?.id
  const videos = sequence.clips.filter((c) => c.type === 'video')
  const onMain = videos.filter((c) => c.trackId === mainId)
  return (onMain.length > 0 ? onMain : videos)
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((clip: TimelineClip) => ({
      clipId: clip.id,
      mediaId: clip.mediaId,
      startTime: clip.startTime,
      endTime: clip.startTime + clip.duration,
      sourceIn: clip.sourceIn,
      rate: clipRate(clip)
    }))
}

/** A video's own transcript (times in its file) moved onto the Timeline
 * under its clip: only the part of the file the clip shows, shifted by the
 * clip's position and speed. Ids and speakers are made unique per clip, so
 * episode 2's "Speaker 1" is never merged with episode 1's. */
export function placePartTranscript(
  part: BatchPart,
  partLabel: string,
  segments: TranscriptSegment[],
  speakers: DetectedSpeakerProfile[]
): { segments: TranscriptSegment[]; speakers: DetectedSpeakerProfile[] } {
  const fileStart = part.sourceIn
  const fileEnd = part.sourceIn + (part.endTime - part.startTime) * part.rate
  const toTimeline = (t: number): number => part.startTime + (t - part.sourceIn) / part.rate
  const idMap = new Map<string, string>()
  const speakerId = (id: string | undefined): string | undefined => (id ? `${part.clipId}:${id}` : undefined)
  const placed: TranscriptSegment[] = []
  for (const segment of segments) {
    if (segment.endTime <= fileStart || segment.startTime >= fileEnd) continue
    const id = `${part.clipId}-${placed.length + 1}`
    idMap.set(segment.id, id)
    const startTime = Math.max(part.startTime, toTimeline(segment.startTime))
    const endTime = Math.min(part.endTime, toTimeline(segment.endTime))
    if (endTime <= startTime) continue
    placed.push({ ...segment, id, startTime, endTime, words: [], speakerId: speakerId(segment.speakerId) })
  }
  const placedSpeakers = speakers.map((speaker) => ({
    ...speaker,
    id: speakerId(speaker.id)!,
    name: `${partLabel} · ${speaker.name}`,
    segmentIds: speaker.segmentIds.map((id) => idMap.get(id)).filter((id): id is string => !!id)
  }))
  return { segments: placed, speakers: placedSpeakers.filter((s) => s.segmentIds.length > 0) }
}

/** Replaces whatever subtitles sat under this clip with its new ones. */
export function mergePartSegments(existing: TranscriptSegment[], part: BatchPart, placed: TranscriptSegment[]): TranscriptSegment[] {
  const kept = existing.filter((s) => s.startTime < part.startTime || s.startTime >= part.endTime)
  return [...kept, ...placed].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

/** The subtitles under one clip, back in that video's own time -- to save
 * one SRT per episode. */
export function partLocalSegments(all: TranscriptSegment[], part: BatchPart): TranscriptSegment[] {
  const toFile = (t: number): number => part.sourceIn + (t - part.startTime) * part.rate
  return all
    .filter((s) => s.startTime >= part.startTime && s.startTime < part.endTime)
    .map((s) => ({ ...s, startTime: toFile(s.startTime), endTime: toFile(s.endTime) }))
}

/** Where a Timeline line really is: the video under it and the line's
 * start/end inside that video's own file. Null when no video clip covers
 * it. One video at 0 gives the same times back; after Batch Load, episode
 * 2's line at 21 s is 1 s into episode 2's file. */
export function lineSource(parts: BatchPart[], startTime: number, endTime: number): { mediaId: string; start: number; end: number } | null {
  const part = parts.find((p) => startTime >= p.startTime && startTime < p.endTime)
  if (!part) return null
  const toFile = (t: number): number => part.sourceIn + (Math.min(t, part.endTime) - part.startTime) * part.rate
  return { mediaId: part.mediaId, start: toFile(startTime), end: toFile(endTime) }
}

/** A stretch of a video with no subtitle line -- where Auto SRT may have
 * missed dialogue (music, noise, a part Gemini could not read). Given in
 * Timeline time (to show) and in the video file's own time (to send back
 * to Gemini for "Fill gaps"). */
export interface SubtitleGap {
  timelineStart: number
  timelineEnd: number
  fileStart: number
  fileEnd: number
}

/** Missed-dialogue suspects under one clip: every stretch of at least
 * `minSeconds` with no line, from the clip's start to its end. A real
 * silent scene is one too -- they are offered for checking, not trusted. */
export function findGaps(part: BatchPart, lines: TranscriptSegment[], minSeconds = 20): SubtitleGap[] {
  const toFile = (t: number): number => part.sourceIn + (t - part.startTime) * part.rate
  const under = lines.filter((l) => l.startTime >= part.startTime && l.startTime < part.endTime).sort((a, b) => a.startTime - b.startTime)
  const gaps: SubtitleGap[] = []
  let cursor = part.startTime
  const add = (from: number, to: number): void => {
    if (to - from >= minSeconds) gaps.push({ timelineStart: from, timelineEnd: to, fileStart: toFile(from), fileEnd: toFile(to) })
  }
  for (const line of under) {
    add(cursor, line.startTime)
    cursor = Math.max(cursor, line.endTime)
  }
  add(cursor, part.endTime)
  return gaps
}

/** "Fill gaps" result: the new lines that fall inside the gaps, added to
 * what is there -- nothing already there is removed or moved. */
export function mergeGapLines(existing: TranscriptSegment[], gaps: SubtitleGap[], placed: TranscriptSegment[]): TranscriptSegment[] {
  const inside = placed.filter((l) => gaps.some((g) => (l.startTime + l.endTime) / 2 >= g.timelineStart && (l.startTime + l.endTime) / 2 < g.timelineEnd))
  return [...existing, ...inside].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

/** A file name reduced for matching an SRT to its video: no folder, no
 * extension, no trailing language tag ("EP01.km.srt" -> "ep01"). */
function matchStem(fileName: string): string {
  const base = fileName.split(/[\/]/).pop() ?? fileName
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/\.(?:[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?|default|forced)$/i, '')
    .trim()
    .toLowerCase()
}

/** The episode number in a file name: the last number in it ("EP 12",
 * "第12集", "Drama-012.mp4" -> 12). */
function episodeNumber(fileName: string): number | null {
  const numbers = matchStem(fileName).match(/\d+/g)
  return numbers ? Number(numbers[numbers.length - 1]) : null
}

/** Which video each SRT belongs to when several are added at once:
 * the same name first ("EP01.mp4" + "EP01.srt"), then the same episode
 * number ("Ep 1.mp4" + "1.km.srt"), then whatever is left in name order.
 * Returns, per SRT, its video's index (or null when there is no video
 * left for it). Each video gets at most one SRT. */
export function pairSrtsWithVideos(videoNames: string[], srtNames: string[]): (number | null)[] {
  const result: (number | null)[] = srtNames.map(() => null)
  const taken = new Set<number>()
  const assign = (match: (srt: string, video: string) => boolean): void => {
    srtNames.forEach((srt, s) => {
      if (result[s] !== null) return
      const v = videoNames.findIndex((video, i) => !taken.has(i) && match(srt, video))
      if (v >= 0) {
        result[s] = v
        taken.add(v)
      }
    })
  }
  assign((srt, video) => matchStem(srt) === matchStem(video))
  assign((srt, video) => {
    const n = episodeNumber(srt)
    return n !== null && n === episodeNumber(video)
  })
  const byName = (names: string[], indices: number[]): number[] => indices.sort((a, b) => names[a].localeCompare(names[b], undefined, { numeric: true, sensitivity: 'base' }))
  const leftSrts = byName(srtNames, srtNames.map((_, i) => i).filter((i) => result[i] === null))
  const leftVideos = byName(videoNames, videoNames.map((_, i) => i).filter((i) => !taken.has(i)))
  leftSrts.forEach((s, k) => {
    if (k < leftVideos.length) result[s] = leftVideos[k]
  })
  return result
}
