import { computeSequenceDuration, type ProjectSequence, type TimelineClip } from '@shared/project'
import type { TranscriptSegment } from '@shared/transcription'
import { clipRate } from '@shared/clipTiming'
import { canSplitClip, splitClip } from '../sequence/sequenceOps'

/** Video Sync -- the other way to fit a Khmer line that is longer than the
 * original: instead of speeding the voice up (Auto-Speed, capped at 1.25x
 * because a faster voice was what made lines unclear), the picture under
 * that line plays a little slower, and everything after it moves later.
 *
 * Never slower than this, counting any slow-down already applied: past it a
 * scene visibly drags. A line that still does not fit runs a little late,
 * as before. */
export const VIDEO_SYNC_MIN_RATE = 0.85
/** A breath after the line before the next one starts. */
const BREATH_SECONDS = 0.05
/** Times are kept to the microsecond: float sums (2.412 + 9.8) otherwise
 * leave a clip ending a hair past the next edge, and the split there made
 * a zero-length piece. */
const EDGE_EPSILON = 1e-3
const tidy = (seconds: number): number => Math.round(seconds * 1e6) / 1e6

export interface VideoSyncLine {
  /** The subtitle's start, Timeline seconds. */
  start: number
  /** Room until the next subtitle starts (its own length for the last). */
  room: number
  /** The dubbed take's length on the Timeline. */
  clipSeconds: number
  /** The picture's current rate at this line (1 unless already slowed). */
  videoRate: number
}

/** One stretch of the Timeline [start, end) played at `rate` (< 1). */
export interface VideoSyncRegion {
  start: number
  end: number
  rate: number
}

/** Which lines' room is slowed, and by how much. */
export function planVideoSync(lines: VideoSyncLine[]): VideoSyncRegion[] {
  const regions: VideoSyncRegion[] = []
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    if (!(line.room > 0)) continue
    const needed = line.clipSeconds + BREATH_SECONDS
    if (needed <= line.room + 0.02) continue
    const floor = VIDEO_SYNC_MIN_RATE / Math.max(VIDEO_SYNC_MIN_RATE, line.videoRate || 1)
    const rate = Math.round(Math.max(floor, line.room / needed) * 1000) / 1000
    if (rate >= 0.995) continue
    const previous = regions[regions.length - 1]
    // Rooms run subtitle to subtitle, so they never overlap; guard anyway.
    if (previous && line.start < previous.end) continue
    regions.push({ start: line.start, end: line.start + line.room, rate })
  }
  return regions
}

/** Where a moment of the old Timeline lands once the regions are slowed. */
export function mapVideoSyncTime(regions: VideoSyncRegion[], time: number): number {
  let shift = 0
  for (const region of regions) {
    if (time <= region.start) break
    const added = (region.end - region.start) * (1 / region.rate - 1)
    if (time < region.end) return time + shift + (time - region.start) * (1 / region.rate - 1)
    shift += added
  }
  return time + shift
}

/** Seconds the whole Timeline grows by. */
export function videoSyncAddedSeconds(regions: VideoSyncRegion[]): number {
  return regions.reduce((total, region) => total + (region.end - region.start) * (1 / region.rate - 1), 0)
}

/** The sequence with the regions slowed. Clips `stretch` accepts (the
 * picture, its own sound, the music bed under the dub) are cut at the
 * region edges and the pieces inside play slower; every other clip -- the
 * dubbed lines, added music, text -- keeps its length and only moves with
 * the time around it. Locked clips are left exactly where they are. */
export function applyVideoSync(
  sequence: ProjectSequence,
  regions: VideoSyncRegion[],
  stretch: (clip: TimelineClip) => boolean,
  makeId?: () => string
): ProjectSequence {
  if (regions.length === 0) return sequence
  let next = sequence
  for (const edge of regions.flatMap((r) => [r.start, r.end])) {
    // A split also splits the linked partner, so look again after each one.
    for (let guard = 0; guard < 1000; guard++) {
      const target = next.clips.find(
        (c) => stretch(c) && canSplitClip(c, edge) && edge - c.startTime > EDGE_EPSILON && c.startTime + c.duration - edge > EDGE_EPSILON
      )
      if (!target) break
      next = splitClip(next, target.id, edge, { linked: true, makeId })
    }
  }
  const regionOf = (start: number, end: number): VideoSyncRegion | undefined =>
    regions.find((r) => start >= r.start - 1e-6 && end <= r.end + 1e-6)
  const clips = next.clips.map((clip) => {
    if (clip.locked) return clip
    const start = tidy(mapVideoSyncTime(regions, clip.startTime))
    if (!stretch(clip)) return { ...clip, startTime: start }
    const region = regionOf(clip.startTime, clip.startTime + clip.duration)
    if (!region) return { ...clip, startTime: start }
    const duration = tidy(mapVideoSyncTime(regions, clip.startTime + clip.duration) - start)
    if (clip.type === 'image') return { ...clip, startTime: start, duration }
    return { ...clip, startTime: start, duration, playbackRate: Math.round(clipRate(clip) * region.rate * 10000) / 10000 }
  })
  const markers = next.markers.map((marker) => ({ ...marker, time: tidy(mapVideoSyncTime(regions, marker.time)) }))
  return { ...next, clips, markers, duration: computeSequenceDuration(clips) }
}

/** The subtitles moved with the picture: each start and end (and word)
 * lands where its moment of the video now is. */
export function retimeSegmentsForVideoSync(segments: TranscriptSegment[], regions: VideoSyncRegion[]): TranscriptSegment[] {
  if (regions.length === 0) return segments
  const at = (time: number): number => tidy(mapVideoSyncTime(regions, time))
  return segments.map((segment) => ({
    ...segment,
    startTime: at(segment.startTime),
    endTime: at(segment.endTime),
    words: segment.words.map((word) => ({ ...word, startTime: at(word.startTime), endTime: at(word.endTime) }))
  }))
}
