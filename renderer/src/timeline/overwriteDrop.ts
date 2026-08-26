// Overwrite drop mode (spec section 9) -- scoped narrowly, as re-confirmed
// by the requester after this was deferred entirely from the prior Timeline
// pass: same-track, exact-overlap-range replace only, gated behind a
// blocking confirm (the same window.confirm pattern already used for
// deleting a non-empty track in TrackHeaderMenu.tsx -- no new modal
// infrastructure needed). Unlike Stack (findOrCreateTrack routes around
// collisions) and Insert (ripple.ts pushes everything later), Overwrite is
// the one mode that can destroy existing footage, which is exactly why it
// stayed out of scope until explicitly re-requested with this narrower shape.
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { applyTrim } from '../sequence/sequenceOps'

type IdFactory = () => string
const defaultMakeId: IdFactory = () => crypto.randomUUID()

export interface OverwritePreview {
  /** Clips entirely inside the overwritten range -- deleted outright. */
  removedClipIds: string[]
  /** Clips only partially overlapping the range -- trimmed (or, for a clip
   * that fully contains the range, split into a left and right remainder). */
  trimmedClipIds: string[]
}

/** What would happen if a clip of `duration` seconds were overwritten onto
 * `trackId` at `startTime` -- null if nothing on that track overlaps (i.e.
 * there's nothing to confirm; the caller can just insert normally). Locked
 * clips are excluded (never overwritten). */
export function computeOverwritePreview(sequence: ProjectSequence, trackId: string, startTime: number, duration: number): OverwritePreview | null {
  const endTime = startTime + duration
  const overlapping = sequence.clips.filter((c) => c.trackId === trackId && !c.locked && c.startTime < endTime && c.startTime + c.duration > startTime)
  if (overlapping.length === 0) return null

  const removedClipIds: string[] = []
  const trimmedClipIds: string[] = []
  for (const c of overlapping) {
    const cEnd = c.startTime + c.duration
    const fullyContained = c.startTime >= startTime && cEnd <= endTime
    if (fullyContained) removedClipIds.push(c.id)
    else trimmedClipIds.push(c.id)
  }
  return { removedClipIds, trimmedClipIds }
}

/** Actually performs the overwrite: removes/trims/splits whatever overlaps
 * `newClip`'s range on its track (see computeOverwritePreview for the same
 * classification), then inserts `newClip`. Call only after the user has
 * confirmed (via computeOverwritePreview's result) -- this function itself
 * does not ask. */
export function applyOverwrite(sequence: ProjectSequence, newClip: Omit<TimelineClip, 'id'>, makeId: IdFactory = defaultMakeId): ProjectSequence {
  const trackId = newClip.trackId
  const startTime = newClip.startTime
  const endTime = startTime + newClip.duration

  const clips: TimelineClip[] = []
  for (const c of sequence.clips) {
    if (c.trackId !== trackId || c.locked) {
      clips.push(c)
      continue
    }
    const cEnd = c.startTime + c.duration
    const overlaps = c.startTime < endTime && cEnd > startTime
    if (!overlaps) {
      clips.push(c)
      continue
    }

    const startsBefore = c.startTime < startTime
    const endsAfter = cEnd > endTime

    if (startsBefore && endsAfter) {
      // Fully contains the overwritten range -- split into a left and right remainder.
      clips.push(applyTrim(c, 'right', startTime))
      clips.push(applyTrim({ ...c, id: makeId() }, 'left', endTime))
    } else if (startsBefore) {
      clips.push(applyTrim(c, 'right', startTime))
    } else if (endsAfter) {
      clips.push(applyTrim(c, 'left', endTime))
    }
    // else: entirely inside the overwritten range -- dropped.
  }

  clips.push({ ...newClip, id: makeId() })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}
