import type { TimelineClip } from './project'

/** A clip's source window is independent of its duration on the timeline. */
export function clipRate(clip: TimelineClip): number {
  const rate = clip.playbackRate ?? 1
  return Number.isFinite(rate) && rate > 0 ? rate : 1
}

export function sourceTimeAt(clip: TimelineClip, timelineTime: number): number {
  return clip.sourceIn + (timelineTime - clip.startTime) * clipRate(clip)
}

export function timelineTimeAtSource(clip: TimelineClip, sourceTime: number): number {
  return clip.startTime + (sourceTime - clip.sourceIn) / clipRate(clip)
}

export function sourceEnd(clip: TimelineClip): number {
  return clip.sourceOut ?? clip.sourceIn + clip.duration * clipRate(clip)
}
