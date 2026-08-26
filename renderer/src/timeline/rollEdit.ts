// Roll Edit (spec section 10) -- moves the shared boundary between two
// adjacent clips on the same track in one drag: the left clip's out point
// and the right clip's in point move together, so there's never a gap or
// overlap between them. Implemented as applyTrim'ing BOTH clips' facing
// edges to the SAME pointer time -- trimming left's right edge to X and
// right's left edge to X is exactly roll-edit semantics (left's end and
// right's start both land at X, right's own end stays fixed), so this reuses
// sequenceOps.ts's exact trim math rather than duplicating it.
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { applyTrim, MIN_CLIP_DURATION_SECONDS } from '../sequence/sequenceOps'

/** True only when both clips exist, are unlocked, share a track, and `right`
 * starts exactly where `left` ends (a genuinely shared boundary -- roll edit
 * doesn't make sense across a gap or overlap). */
export function canRollEdit(clips: TimelineClip[], leftClipId: string, rightClipId: string): boolean {
  const left = clips.find((c) => c.id === leftClipId)
  const right = clips.find((c) => c.id === rightClipId)
  if (!left || !right || left.locked || right.locked) return false
  if (left.trackId !== right.trackId) return false
  return Math.abs(right.startTime - (left.startTime + left.duration)) < 1e-9
}

/** `sourceDurationSecondsByClip` mirrors trimClip's own optional source-
 * bound param, keyed by clip id (roll edit needs both clips' source
 * durations at once). A no-op (same reference back) when canRollEdit is
 * false. The new boundary is clamped so neither clip shrinks below
 * MIN_CLIP_DURATION_SECONDS. */
export function rollEdit(
  sequence: ProjectSequence,
  leftClipId: string,
  rightClipId: string,
  pointerTime: number,
  sourceDurationSecondsByClip: Record<string, number | undefined> = {}
): ProjectSequence {
  if (!canRollEdit(sequence.clips, leftClipId, rightClipId)) return sequence
  const left = sequence.clips.find((c) => c.id === leftClipId)!
  const right = sequence.clips.find((c) => c.id === rightClipId)!

  const minBoundary = left.startTime + MIN_CLIP_DURATION_SECONDS
  const maxBoundary = right.startTime + right.duration - MIN_CLIP_DURATION_SECONDS
  const clampedTime = Math.min(maxBoundary, Math.max(minBoundary, pointerTime))

  const newLeft = applyTrim(left, 'right', clampedTime, sourceDurationSecondsByClip[leftClipId])
  const newRight = applyTrim(right, 'left', clampedTime, sourceDurationSecondsByClip[rightClipId])

  const clips = sequence.clips.map((c) => {
    if (c.id === leftClipId) return newLeft
    if (c.id === rightClipId) return newRight
    return c
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}
