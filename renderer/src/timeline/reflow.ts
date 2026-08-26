// Shared low-level clip-shifting primitives used by both magnet.ts (gapless
// main-track behavior) and ripple.ts (explicit Ripple toggle) -- the two
// features do different THINGS with a shift, but the shift math itself
// (move every clip on a track starting at-or-after some time by some delta,
// or close a specific gap) is identical, so it lives here once.
import type { TimelineClip } from '@shared/project'

/** Shifts every unlocked clip on `trackId` whose `startTime >= fromTime` by
 * `deltaSeconds` (clamped so no clip's startTime goes negative). Clips on
 * other tracks, locked clips, and clips already in `excludeClipIds` (e.g.
 * the clip that triggered the shift, already handled by the caller) are
 * left untouched. */
export function shiftClipsFrom(
  clips: TimelineClip[],
  trackId: string,
  fromTime: number,
  deltaSeconds: number,
  excludeClipIds: Set<string> = new Set()
): TimelineClip[] {
  if (deltaSeconds === 0) return clips
  return clips.map((c) => {
    if (c.trackId !== trackId || c.locked || excludeClipIds.has(c.id)) return c
    if (c.startTime < fromTime) return c
    return { ...c, startTime: Math.max(0, c.startTime + deltaSeconds) }
  })
}

/** Closes a specific [gapStart, gapEnd) window on `trackId` by pulling every
 * clip starting at/after `gapEnd` left by the gap's duration. A no-op for a
 * non-positive-duration "gap". */
export function closeGap(
  clips: TimelineClip[],
  trackId: string,
  gapStart: number,
  gapEnd: number,
  excludeClipIds: Set<string> = new Set()
): TimelineClip[] {
  const gapDuration = gapEnd - gapStart
  if (gapDuration <= 0) return clips
  return shiftClipsFrom(clips, trackId, gapEnd, -gapDuration, excludeClipIds)
}

export interface Gap {
  start: number
  end: number
}

/** Every empty span on `trackId` strictly between clips, in ascending order
 * (never includes the span before the first clip or after the last -- those
 * aren't "gaps" to close, just unused timeline). */
export function findGapsOnTrack(clips: TimelineClip[], trackId: string): Gap[] {
  const onTrack = clips
    .filter((c) => c.trackId === trackId)
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
  const gaps: Gap[] = []
  let cursor: number | null = null
  for (const c of onTrack) {
    if (cursor !== null && c.startTime > cursor) gaps.push({ start: cursor, end: c.startTime })
    cursor = cursor === null ? c.startTime + c.duration : Math.max(cursor, c.startTime + c.duration)
  }
  return gaps
}
