import { computeSequenceDuration, type ProjectSequence, type TimelineClip } from '@shared/project'
import type { TranscriptSegment } from '@shared/transcription'
import { clipRate } from '@shared/clipTiming'
import { canSplitClip, splitClip } from '../sequence/sequenceOps'
import { mapVideoSyncTime, type VideoSyncRegion } from '@shared/videoSyncPlan'

export { VIDEO_SYNC_MIN_RATE, mapVideoSyncTime, planVideoSync, videoSyncAddedSeconds, type VideoSyncLine, type VideoSyncRegion } from '@shared/videoSyncPlan'

/** Times are kept to the microsecond: float sums (2.412 + 9.8) otherwise
 * leave a clip ending a hair past the next edge, and the split there made
 * a zero-length piece. */
const EDGE_EPSILON = 1e-3
const tidy = (seconds: number): number => Math.round(seconds * 1e6) / 1e6

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
