// Gap interaction (spec section 12) -- gaps are represented as real time,
// not a fake clip entity, so these operate purely on `sequence.clips`
// positions via reflow.ts's primitives. The right-click gap menu / double-
// click-to-select-a-gap UI (Timeline.tsx, later work) calls these directly.
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { findGapsOnTrack, closeGap, shiftClipsFrom, type Gap } from './reflow'

export type { Gap }

/** The gap on `trackId` that contains `time`, if any (null if `time` falls
 * inside a clip, before the first clip, or after the last one -- none of
 * those are a "gap" a user could right-click to remove). */
export function findGapAt(sequence: ProjectSequence, trackId: string, time: number): Gap | null {
  return findGapsOnTrack(sequence.clips, trackId).find((g) => time >= g.start && time < g.end) ?? null
}

/** Every OTHER track carrying the linked partner of a clip on `trackId` that
 * sits at/after `fromTime` (and would therefore shift) -- e.g. closing a gap
 * on the video track (V1) must pull the matching dialogue clips on the
 * linked audio track (A1) along with it too, the same "linked partner"
 * concept ripple.ts's resolveRippleTrackIds already applies to Ripple
 * trim/delete/insert. Without this, gap removal desynced every linked
 * video/audio pair after the closed gap -- the audio silently stayed put
 * while its video slid left. */
function linkedPartnerTrackIds(clips: TimelineClip[], trackId: string, fromTime: number): Set<string> {
  const trackIds = new Set<string>()
  for (const c of clips) {
    if (c.trackId !== trackId || c.startTime < fromTime || !c.linkedClipId) continue
    const partner = clips.find((p) => p.id === c.linkedClipId)
    if (partner) trackIds.add(partner.trackId)
  }
  return trackIds
}

/** Removes exactly one gap, shifting everything after it left by the gap's
 * duration. Respects locks via reflow.ts's shiftClipsFrom (a locked clip
 * simply doesn't move, which can reintroduce a smaller gap after it -- an
 * intentional, visible consequence of the lock rather than silently
 * overriding it). `linked` (on by default, matching every other mutation in
 * sequenceOps.ts) also closes the same [gapStart, gapEnd) window on any
 * track holding a linked partner of a clip being shifted. */
export function removeGap(sequence: ProjectSequence, trackId: string, gapStart: number, gapEnd: number, linked = true): ProjectSequence {
  let clips = closeGap(sequence.clips, trackId, gapStart, gapEnd)
  if (linked) {
    for (const tid of linkedPartnerTrackIds(sequence.clips, trackId, gapEnd)) {
      clips = closeGap(clips, tid, gapStart, gapEnd)
    }
  }
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Removes every gap on `trackId`, left to right, one Undo entry's worth of
 * work (the caller wraps this whole call in one transaction/auto-record,
 * same as every other multi-step sequence op in this codebase). */
export function removeAllGapsOnTrack(sequence: ProjectSequence, trackId: string, linked = true): ProjectSequence {
  let clips = sequence.clips
  // Re-scan after each close rather than closing all originally-found gaps
  // in one pass -- closing an earlier gap shifts the positions any
  // later-found gap was measured against.
  while (true) {
    const gaps = findGapsOnTrack(clips, trackId)
    if (gaps.length === 0) break
    const { start, end } = gaps[0]
    const partnerTrackIds = linked ? linkedPartnerTrackIds(clips, trackId, end) : new Set<string>()
    clips = closeGap(clips, trackId, start, end)
    for (const tid of partnerTrackIds) {
      clips = closeGap(clips, tid, start, end)
    }
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
