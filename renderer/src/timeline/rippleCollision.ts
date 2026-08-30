// Gap-Aware Ripple Insert: when a clip lands on an occupied position on its
// OWN track, this resolves the collision by either snapping cleanly into an
// existing gap (nothing else moves) or ripple-pushing the overlapping clip
// and everything after it to the right -- never by silently routing the
// clip to a different track or auto-creating one (that's trackModel.ts's
// findOrCreateTrack, a DIFFERENT policy used where hopping tracks is the
// desired behavior, e.g. planSequentialDrop). This module is the single
// source of truth for that "stay on this track, make room instead" policy,
// shared by every insertion path that needs it (drag-move, new media,
// paste, duplicate, template/scene insert).
import type { TimelineClip } from '@shared/project'

export interface RippleInsertPlan {
  /** True if `insertStart`..`insertStart+insertDuration` is already clear on
   * the track (an empty gap, or literally empty space before/after
   * everything else) -- nothing needs to move. False means at least one
   * clip in `pushes` must shift right first. */
  fits: boolean
  /** clipId -> new startTime, for every clip on the track that must move
   * right to make room. Empty when `fits` is true. Never includes a locked
   * clip (locked clips are treated as immovable obstacles the cascade jumps
   * past instead) or a clip in `excludeClipIds`. */
  pushes: Map<string, number>
}

/** Plans the minimal set of same-track pushes needed to make room for a
 * `insertDuration`-second clip landing at `insertStart`, preserving every
 * other clip's relative order (never reordering, only ever shifting right).
 *
 * Walks the track's clips in start-time order. A clip entirely before
 * `insertStart` is untouched. The first clip whose current start collides
 * with the insertion window (or with wherever the previous push landed) is
 * pushed to start exactly at the current cursor; the cursor then advances
 * past it, and the same check repeats for the next clip. The moment a
 * clip's own start is already >= the cursor, it (and, by the invariant that
 * the input track has no pre-existing overlaps, every clip after it) needs
 * no push at all -- the loop stops there rather than needlessly touching
 * clips further out.
 *
 * A locked clip is never itself pushed, but its span still advances the
 * cursor if the insertion (or an already-planned push) would otherwise land
 * inside it -- an immovable obstacle the cascade routes around rather than
 * one that silently gets overlapped. */
export function planRippleInsert(
  clips: TimelineClip[],
  trackId: string,
  insertStart: number,
  insertDuration: number,
  excludeClipIds: Set<string> = new Set()
): RippleInsertPlan {
  const onTrack = clips.filter((c) => c.trackId === trackId && !excludeClipIds.has(c.id)).sort((a, b) => a.startTime - b.startTime)

  let cursor = insertStart + insertDuration
  const pushes = new Map<string, number>()

  for (const clip of onTrack) {
    const clipEnd = clip.startTime + clip.duration
    if (clipEnd <= insertStart) continue // entirely before the insertion point -- untouched
    if (clip.startTime >= cursor) break // this and everything after (sorted, originally non-overlapping) is already clear

    if (clip.locked) {
      cursor = Math.max(cursor, clipEnd)
      continue
    }
    pushes.set(clip.id, cursor)
    cursor += clip.duration
  }

  return { fits: pushes.size === 0, pushes }
}

/** Extends a ripple plan's pushes to each pushed clip's own linked partner
 * (video<->audio), so a linked pair keeps moving together even when only
 * one half of the pair actually collided on its own track -- e.g. ripple on
 * V1 pushes a video clip right, its A1 audio partner shifts by the exact
 * same delta to stay in sync, even though A1 itself may have had room to
 * spare. A partner already in `pushes` (both halves independently
 * collided) is left as originally planned rather than overwritten. Locked
 * partners never move, matching every other linked-cascade in this
 * codebase (moveClip, rippleTrim, etc). */
export function extendRippleInsertWithLinkedPartners(clips: TimelineClip[], pushes: Map<string, number>): Map<string, number> {
  const extended = new Map(pushes)
  for (const [clipId, newStart] of pushes) {
    const clip = clips.find((c) => c.id === clipId)
    if (!clip?.linkedClipId || extended.has(clip.linkedClipId)) continue
    const partner = clips.find((c) => c.id === clip.linkedClipId)
    if (!partner || partner.locked) continue
    const delta = newStart - clip.startTime
    extended.set(partner.id, Math.max(0, partner.startTime + delta))
  }
  return extended
}
