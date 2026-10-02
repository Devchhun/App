// CapCut-style Auto Ripple (spec section 3) -- an independent toggle from
// Magnet (magnet.ts) and Snapping (snapping.ts). Unlike Magnet, which is
// permanently scoped to the one main video track, Ripple can apply to any
// track and its effect is configurable via `RippleScope`. Locked tracks are
// excluded from 'all-unlocked' scope; a locked individual clip is never
// itself moved (matching sequenceOps.ts's existing per-clip lock guards).
import type { ProjectSequence, TimelineClip } from '@shared/project'
import type { TimelineTrack } from '@shared/timelineTracks'
import { computeSequenceDuration, sanitizeLinkedClips } from '@shared/project'
import { applyTrim, type TrimEdge } from '../sequence/sequenceOps'
import { clipRate, sourceEnd } from '@shared/clipTiming'
import { shiftClipsFrom, closeGap } from './reflow'
import type { RippleScope } from './timelineViewPrefs'

export type { RippleScope }

/** Which tracks a ripple operation affects, given the track the triggering
 * clip lives on: 'current' -> just that track. 'all-unlocked' -> every
 * unlocked track in the project. 'linked' -> that track plus the track(s)
 * of any linked partner among `affectedClips` (looked up in `allClips`,
 * which should be the sequence's clips from BEFORE the operation mutates
 * anything, so the link is still resolvable). */
export function resolveRippleTrackIds(
  tracks: TimelineTrack[],
  sourceTrackId: string,
  scope: RippleScope,
  affectedClips: TimelineClip[] = [],
  allClips: TimelineClip[] = []
): string[] {
  if (scope === 'all-unlocked') return tracks.filter((t) => !t.locked).map((t) => t.id)
  const trackIds = new Set([sourceTrackId])
  if (scope === 'linked') {
    for (const clip of affectedClips) {
      if (!clip.linkedClipId) continue
      const partner = allClips.find((c) => c.id === clip.linkedClipId)
      if (partner) trackIds.add(partner.trackId)
    }
  }
  return [...trackIds]
}

/** Makes room for an about-to-be-inserted `duration`-second clip at `atTime`
 * on `trackId`, by pushing every clip at/after `atTime` on every track in
 * `scope` to the right by `duration`. Pure "make room" primitive -- the
 * caller inserts the actual clip separately (mirrors magnet.ts's
 * insertClipMagnetic, which combines the two for the main-track case; here
 * scope can span multiple tracks so the steps stay separate). */
export function rippleInsert(sequence: ProjectSequence, trackId: string, atTime: number, duration: number, scope: RippleScope): ProjectSequence {
  const scopedTrackIds = resolveRippleTrackIds(sequence.tracks, trackId, scope)
  let clips = sequence.clips
  for (const tid of scopedTrackIds) {
    clips = shiftClipsFrom(clips, tid, atTime, duration)
  }
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Deletes every unlocked clip in `clipIds` and closes the gap each one
 * leaves behind, across every track in `scope` for that clip. Multiple
 * targets are processed in start-time order so overlapping shifts compound
 * correctly. Locked clips in the set are left untouched (never silently
 * deleted), matching sequenceOps.deleteClips. */
export function rippleDelete(sequence: ProjectSequence, clipIds: string[], scope: RippleScope): ProjectSequence {
  const idSet = new Set(clipIds)
  const targets = sequence.clips.filter((c) => idSet.has(c.id) && !c.locked)
  if (targets.length === 0) return sequence

  // A linked pair is one logical clip for deletion (same reasoning as
  // sequenceOps.deleteClips's own `linked` default, and independent of
  // `scope` -- scope governs which TRACKS' later clips shift to close a
  // gap, not which clips get deleted). Without this, Ripple Delete removed
  // only the explicitly selected clip and left its linked partner sitting
  // exactly where it was, with everything around it shifted -- a stray
  // clip stranded in what looks like empty space, easy to miss entirely.
  for (const target of targets) {
    if (!target.linkedClipId) continue
    const partner = sequence.clips.find((c) => c.id === target.linkedClipId)
    if (partner && !partner.locked) idSet.add(partner.id)
  }

  const originalClips = sequence.clips
  let clips = sequence.clips.filter((c) => !idSet.has(c.id) || c.locked)

  const sortedTargets = [...targets].sort((a, b) => a.startTime - b.startTime)
  for (const target of sortedTargets) {
    const scopedTrackIds = resolveRippleTrackIds(sequence.tracks, target.trackId, scope, [target], originalClips)
    for (const tid of scopedTrackIds) {
      clips = closeGap(clips, tid, target.startTime, target.startTime + target.duration)
    }
  }

  // A LOCKED partner is deliberately never added to `idSet` above, so it can
  // survive its now-deleted target -- still pointing at a clip that no
  // longer exists. Clears that dangling reference (and its 🔗 badge) in this
  // same returned snapshot -- see sanitizeLinkedClips's own doc comment.
  clips = sanitizeLinkedClips(clips)

  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Trims `clipId`'s right edge (reusing sequenceOps.applyTrim's exact math)
 * and ripples the change across `scope`: shortening pulls everything after
 * it left, extending pushes everything after it right. Left-edge trims are
 * applied normally (via the same applyTrim math) WITHOUT rippling earlier
 * clips -- the spec's own ripple description ("extending pushes later clips
 * right") is framed around the out-point/right edge, and rippling clips
 * that come BEFORE the trimmed one is a materially different, rarer
 * operation not covered by that description. A no-op for a missing or
 * locked clip. */
export function rippleTrim(
  sequence: ProjectSequence,
  clipId: string,
  edge: TrimEdge,
  pointerTime: number,
  scope: RippleScope,
  sourceDurationSeconds?: number,
  linked = true,
  partnerSourceDurationSeconds?: number
): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const partner = linked && target.linkedClipId ? sequence.clips.find((c) => c.id === target.linkedClipId) : undefined
  if (partner?.locked) return sequence
  let boundedTime = pointerTime
  if (edge === 'right') {
    // A still image has no source end (see sequenceOps.ts's trimClip).
    if (target.type !== 'image' && Number.isFinite(sourceDurationSeconds)) boundedTime = Math.min(boundedTime, target.startTime + ((sourceDurationSeconds as number) - target.sourceIn) / clipRate(target))
    if (partner) boundedTime = Math.min(boundedTime, partner.startTime + ((partnerSourceDurationSeconds ?? sourceEnd(partner)) - partner.sourceIn) / clipRate(partner))
  }
  const trimmedClip = applyTrim(target, edge, boundedTime, sourceDurationSeconds)
  const trimmedPartner = partner ? applyTrim(partner, edge, boundedTime, partnerSourceDurationSeconds ?? sourceEnd(partner)) : undefined
  let clips = sequence.clips.map((c) => c.id === clipId ? trimmedClip : c.id === partner?.id ? trimmedPartner! : c)

  if (edge === 'right') {
    const oldEnd = target.startTime + target.duration
    const delta = trimmedClip.duration - target.duration
    const scopedTrackIds = new Set(resolveRippleTrackIds(sequence.tracks, target.trackId, scope, [target], sequence.clips))
    if (partner) scopedTrackIds.add(partner.trackId)
    for (const tid of scopedTrackIds) {
      clips = shiftClipsFrom(clips, tid, oldEnd, delta, new Set([clipId, ...(partner ? [partner.id] : [])]))
    }
  }

  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}
