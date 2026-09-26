import { sourceEnd, sourceTimeAt, timelineTimeAtSource } from '@shared/clipTiming'
import type { TimelineClip } from '@shared/project'
import type { TranscriptSegment } from '@shared/transcription'
import type { StoryOutline, VideoStoryNarrationScene } from '@shared/videoStoryNarration'

/** The recap panel works in two clocks. Captions live on the Timeline (the
 * Timeline, the preview and the AI Dubber all read a transcript's times as
 * Timeline times), while Gemini watches the source file. For an untrimmed
 * clip at 0 they are the same; once the clip's head is trimmed (a teaser cut
 * off) they are not, and a recap fed Timeline times against the whole
 * source file put every event minutes early. These convert at the boundary.
 * Without a clip everything passes through unchanged. */

/** The part of the source the clip shows, in source seconds. */
export function clipSourceRange(clip: TimelineClip | undefined, durationSeconds: number): { start: number; end: number } {
  if (!clip) return { start: 0, end: durationSeconds }
  const start = Math.max(0, Math.min(durationSeconds, clip.sourceIn))
  return { start, end: Math.max(start, Math.min(durationSeconds, sourceEnd(clip))) }
}

function mapSegments(segments: TranscriptSegment[], map: (t: number) => number, from: number, to: number): TranscriptSegment[] {
  return segments.flatMap((segment) => {
    const startTime = Math.max(from, map(segment.startTime))
    const endTime = Math.min(to, map(segment.endTime))
    if (!(endTime > startTime)) return []
    return [{ ...segment, startTime, endTime, words: segment.words.map((word) => ({ ...word, startTime: Math.max(startTime, Math.min(endTime, map(word.startTime))), endTime: Math.max(startTime, Math.min(endTime, map(word.endTime))) })) }]
  })
}

/** Timeline captions -> source seconds, only those inside the clip. */
export function segmentsToSource(segments: TranscriptSegment[], clip: TimelineClip | undefined, durationSeconds: number): TranscriptSegment[] {
  if (!clip) return segments
  const range = clipSourceRange(clip, durationSeconds)
  return mapSegments(segments, (t) => sourceTimeAt(clip, t), range.start, range.end)
}

/** An SRT made for the source file -> Timeline captions for this clip, so
 * they line up with the picture without being dragged by hand. */
export function sourceSegmentsToTimeline(segments: TranscriptSegment[], clip: TimelineClip | undefined, durationSeconds: number): TranscriptSegment[] {
  if (!clip) return segments
  const range = clipSourceRange(clip, durationSeconds)
  const inClip = segments.filter((segment) => segment.endTime > range.start && segment.startTime < range.end)
  return mapSegments(inClip, (t) => timelineTimeAtSource(clip, Math.max(range.start, Math.min(range.end, t))), 0, Number.POSITIVE_INFINITY)
}

/** Gemini's outline (source seconds) -> Timeline seconds. */
export function outlineToTimeline(outline: StoryOutline, clip: TimelineClip | undefined): StoryOutline {
  if (!clip) return outline
  return { ...outline, beats: outline.beats.map((beat) => ({ ...beat, startTime: Math.max(0, timelineTimeAtSource(clip, beat.startTime)), endTime: Math.max(0, timelineTimeAtSource(clip, beat.endTime)) })) }
}

export function sceneToSource(scene: VideoStoryNarrationScene, clip: TimelineClip | undefined): VideoStoryNarrationScene {
  return clip ? { ...scene, startTime: sourceTimeAt(clip, scene.startTime), endTime: sourceTimeAt(clip, scene.endTime) } : scene
}

export function sceneToTimeline(scene: VideoStoryNarrationScene, clip: TimelineClip | undefined): VideoStoryNarrationScene {
  return clip ? { ...scene, startTime: Math.max(0, timelineTimeAtSource(clip, scene.startTime)), endTime: Math.max(0, timelineTimeAtSource(clip, scene.endTime)) } : scene
}
