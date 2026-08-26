// Gap interaction (spec section 12) -- gaps are represented as real time,
// not a fake clip entity, so these operate purely on `sequence.clips`
// positions via reflow.ts's primitives. The right-click gap menu / double-
// click-to-select-a-gap UI (Timeline.tsx, later work) calls these directly.
import type { ProjectSequence } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { findGapsOnTrack, closeGap, shiftClipsFrom, type Gap } from './reflow'

export type { Gap }

/** The gap on `trackId` that contains `time`, if any (null if `time` falls
 * inside a clip, before the first clip, or after the last one -- none of
 * those are a "gap" a user could right-click to remove). */
export function findGapAt(sequence: ProjectSequence, trackId: string, time: number): Gap | null {
  return findGapsOnTrack(sequence.clips, trackId).find((g) => time >= g.start && time < g.end) ?? null
}

/** Removes exactly one gap, shifting everything after it left by the gap's
 * duration. Respects locks via reflow.ts's shiftClipsFrom (a locked clip
 * simply doesn't move, which can reintroduce a smaller gap after it -- an
 * intentional, visible consequence of the lock rather than silently
 * overriding it). */
export function removeGap(sequence: ProjectSequence, trackId: string, gapStart: number, gapEnd: number): ProjectSequence {
  const clips = closeGap(sequence.clips, trackId, gapStart, gapEnd)
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Removes every gap on `trackId`, left to right, one Undo entry's worth of
 * work (the caller wraps this whole call in one transaction/auto-record,
 * same as every other multi-step sequence op in this codebase). */
export function removeAllGapsOnTrack(sequence: ProjectSequence, trackId: string): ProjectSequence {
  let clips = sequence.clips
  // Re-scan after each close rather than closing all originally-found gaps
  // in one pass -- closing an earlier gap shifts the positions any
  // later-found gap was measured against.
  while (true) {
    const gaps = findGapsOnTrack(clips, trackId)
    if (gaps.length === 0) break
    clips = closeGap(clips, trackId, gaps[0].start, gaps[0].end)
  }
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Inserts `gapDuration` seconds of empty time at `atTime` on `trackId` by
 * pushing every clip at/after it to the right -- the inverse of removeGap. */
export function insertGapAt(sequence: ProjectSequence, trackId: string, atTime: number, gapDuration: number): ProjectSequence {
  if (gapDuration <= 0) return sequence
  const clips = shiftClipsFrom(sequence.clips, trackId, atTime, gapDuration)
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}
