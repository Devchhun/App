// Pure, deterministic operations on a ProjectSequence -- every export here
// is a pure function (sequence/clip in, new sequence/clip out), no React, no
// DOM, no Date.now()/random ids baked into the math (id generation is the
// one exception, isolated to insert/split/duplicate, and swappable in tests
// via the `makeId` param). This is the single source of truth for how
// clips get inserted, moved, trimmed, split, deleted, and duplicated --
// SequenceContext.tsx only wires these into React state + undo/redo
// transactions, it doesn't reimplement any of this math.
import type { ProjectSequence, TimelineClip, Marker } from '@shared/project'
import { computeSequenceDuration, sanitizeLinkedClips } from '@shared/project'
import { clipRate, sourceEnd } from '@shared/clipTiming'
import type { TimelineTrackKind } from '@shared/timelineTracks'
import type { KeyframeableProperty, KeyframeEasing } from '@shared/keyframes'
import { addTrack as addTrackToRegistry, removeTrack as removeTrackFromRegistry, findOrCreateNarrationTrack, findOrCreateDubbingTrack, findOrCreateTrack, ensureTrack, type OccupiedRange } from '../timeline/trackModel'
import { closeGap } from '../timeline/reflow'
import { planRippleInsert, extendRippleInsertWithLinkedPartners } from '../timeline/rippleCollision'

export { computeSequenceDuration }

export const DEFAULT_IMAGE_DURATION_SECONDS = 5
export const MIN_CLIP_DURATION_SECONDS = 0.1

type IdFactory = () => string
const defaultMakeId: IdFactory = () => crypto.randomUUID()

export interface InsertableAsset {
  mediaId: string
  type: 'video' | 'image' | 'audio'
  /** The underlying media asset's real duration -- ignored for images
   * (image clips are never source-bounded). */
  sourceDurationSeconds: number
}

/** Builds the clip(s) a freshly-inserted asset becomes, per the insertion
 * rules: video gets a single full-source clip on `trackId` (its own embedded
 * audio plays through that SAME clip's existing volume/mute/fade-in/fade-out
 * controls, exactly like any other video clip -- no separate audio clip is
 * auto-created), image gets a fixed 5s clip (`sourceOut` stays undefined --
 * never source-bounded), audio gets a full-source clip on the given track.
 * A video's audio is only ever split onto its own linked clip when the user
 * explicitly asks for it (the "Extract to Audio" context menu item, see
 * SequenceContext.extractAudio) -- matching the reference editor's own
 * default (one clip per imported file, audio embedded, until you explicitly
 * detach it) instead of always producing two clips for one imported video,
 * which read as confusing/redundant clutter for the common case. */
export function buildInsertedClips(
  asset: InsertableAsset,
  atTime: number,
  trackId: string,
  makeId: IdFactory = defaultMakeId,
  overrides?: Partial<Pick<TimelineClip, 'muted'>>
): TimelineClip[] {
  const startTime = Math.max(0, atTime)

  if (asset.type === 'image') {
    return [
      {
        id: makeId(),
        mediaId: asset.mediaId,
        type: 'image',
        trackId,
        startTime,
        duration: DEFAULT_IMAGE_DURATION_SECONDS,
        sourceIn: 0,
        sourceOut: undefined,
        locked: false,
        ...overrides
      }
    ]
  }

  if (asset.type === 'audio') {
    return [
      {
        id: makeId(),
        mediaId: asset.mediaId,
        type: 'audio',
        trackId,
        startTime,
        duration: asset.sourceDurationSeconds,
        sourceIn: 0,
        sourceOut: asset.sourceDurationSeconds,
        locked: false,
        ...overrides
      }
    ]
  }

  return [
    {
      id: makeId(),
      mediaId: asset.mediaId,
      type: 'video',
      trackId,
      startTime,
      duration: asset.sourceDurationSeconds,
      sourceIn: 0,
      sourceOut: asset.sourceDurationSeconds,
      locked: false,
      ...overrides
    }
  ]
}

export function insertClip(
  sequence: ProjectSequence,
  asset: InsertableAsset,
  atTime: number,
  trackId: string,
  makeId: IdFactory = defaultMakeId,
  overrides?: Partial<Pick<TimelineClip, 'muted'>>
): ProjectSequence {
  const inserted = buildInsertedClips(asset, atTime, trackId, makeId, overrides)
  // Whatever already sits where a new clip lands (on each track it touches)
  // is pushed right -- an insert never stacks on an existing clip.
  let clips = sequence.clips
  for (const clip of inserted) {
    const plan = planRippleInsert(clips, clip.trackId, clip.startTime, clip.duration)
    const pushes = extendRippleInsertWithLinkedPartners(clips, plan.pushes)
    if (pushes.size > 0) clips = clips.map((c) => (pushes.has(c.id) ? { ...c, startTime: pushes.get(c.id)! } : c))
  }
  clips = [...clips, ...inserted]
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Story Narration Workspace's "Accept & Next" -- inserts an accepted take
 * at the segment's *exact* SRT start time onto `preferredTrackId` (VO1) if
 * it's actually free there, replacing (never duplicating alongside)
 * whichever clip was previously accepted for this same segment.
 * `previousClipId`, when given, is removed first -- this is what guarantees
 * "one accepted clip per segment" regardless of how many times the user
 * re-records and re-accepts. Runs the result through sanitizeLinkedClips
 * (matching every other clip-removing op in this file) so removing a
 * previous take can never leave a dangling linkedClipId reference on
 * anything else, even though narration takes themselves are never linked to
 * another clip.
 *
 * The preferred track can be occupied: recording is never forcibly cut off
 * at the segment's own SRT boundary (see NarrationContext.tsx), so a take
 * that ran long can genuinely overlap an adjacent segment's own already-
 * accepted clip on the same track. Routed collision-aware (see
 * findOrCreateNarrationTrack) onto whichever VO-numbered track actually has
 * room, creating a new one (VO2, VO3, ...) if none does, rather than
 * silently producing two overlapping clips on VO1. */
export function acceptNarrationTake(
  sequence: ProjectSequence,
  preferredTrackId: string,
  startTime: number,
  asset: InsertableAsset,
  previousClipId?: string,
  makeId: IdFactory = defaultMakeId
): { sequence: ProjectSequence; clipId: string } {
  const withoutPrevious = previousClipId ? sanitizeLinkedClips(sequence.clips.filter((c) => c.id !== previousClipId)) : sequence.clips

  // findOrCreateNarrationTrack always prefers the lowest-numbered VO track
  // with room, which is VO1 (== preferredTrackId at every real call site)
  // whenever it's actually free -- preferredTrackId itself only documents
  // that intent at call sites, since the collision-aware routing below is
  // what actually decides.
  const occupied: OccupiedRange[] = withoutPrevious.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
  const routing = findOrCreateNarrationTrack(sequence.tracks, occupied, startTime, asset.sourceDurationSeconds)
  const tracks = routing.newTrack ? [...sequence.tracks, routing.newTrack] : sequence.tracks

  const inserted = buildInsertedClips(asset, startTime, routing.trackId, makeId)
  const clips = [...withoutPrevious, ...inserted]
  return {
    sequence: { ...sequence, tracks, clips, duration: computeSequenceDuration(clips) },
    clipId: inserted[0].id
  }
}

/** AI Dubber's "Generate Dubbing" -- inserts a generated (today: placeholder)
 * clip at a subtitle's *exact* start time onto `preferredTrackId` (DUB1) if
 * it's actually free there, replacing (never duplicating alongside)
 * whichever clip was previously generated for this same subtitle.
 * `previousClipId`, when given, is removed first -- this is what guarantees
 * "one generated clip per subtitle" across regenerations. Structurally
 * identical to acceptNarrationTake, using findOrCreateDubbingTrack instead
 * of findOrCreateNarrationTrack -- see that function's own doc comment for
 * the full reasoning (collision-aware routing, sanitizeLinkedClips safety). */
export function acceptDubbingClip(
  sequence: ProjectSequence,
  preferredTrackId: string,
  startTime: number,
  asset: InsertableAsset,
  previousClipId?: string,
  makeId: IdFactory = defaultMakeId
): { sequence: ProjectSequence; clipId: string } {
  const withoutPrevious = previousClipId ? sanitizeLinkedClips(sequence.clips.filter((c) => c.id !== previousClipId)) : sequence.clips

  const occupied: OccupiedRange[] = withoutPrevious.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
  const routing = findOrCreateDubbingTrack(sequence.tracks, occupied, startTime, asset.sourceDurationSeconds)
  const tracks = routing.newTrack ? [...sequence.tracks, routing.newTrack] : sequence.tracks

  const inserted = buildInsertedClips(asset, startTime, routing.trackId, makeId)
  const clips = [...withoutPrevious, ...inserted]
  return {
    sequence: { ...sequence, tracks, clips, duration: computeSequenceDuration(clips) },
    clipId: inserted[0].id
  }
}

/** Moves a clip so its startTime becomes `newStartTime` (clamped >= 0).
 * Its linked clip (video <-> audio), if any and unlocked, moves by the same
 * delta so they stay in sync -- but ONLY when `linked` is true (default),
 * gated by the Timeline's Linkage toggle at the call site (see
 * SequenceContext.moveClip). A no-op (same reference back) for a missing
 * or locked clip.
 *
 * Gap-Aware Ripple Insert: landing on an occupied spot on the clip's OWN
 * track never silently overlaps or hops to a different track -- it either
 * snaps cleanly into an existing gap big enough for it (nothing else moves)
 * or ripple-pushes the clip(s) in the way, and everything after them, to
 * the right (see rippleCollision.ts's planRippleInsert). Each pushed clip's
 * own linked partner (if any) moves the same delta to stay in sync, even on
 * a different track -- the one case this DOES touch another track, per the
 * "unless linked media requires it" carve-out. Cross-track moves go through
 * moveClipToTrack instead, which has its own (currently collision-free)
 * placement policy. */
export function moveClip(sequence: ProjectSequence, clipId: string, newStartTime: number, linked = true): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence

  const clampedStart = Math.max(0, newStartTime)
  const delta = clampedStart - target.startTime
  if (delta === 0) return sequence

  const linkedId = linked ? target.linkedClipId : undefined
  const excludeIds = new Set([clipId, ...(linkedId ? [linkedId] : [])])
  const ripplePlan = planRippleInsert(sequence.clips, target.trackId, clampedStart, target.duration, excludeIds)
  const pushes = extendRippleInsertWithLinkedPartners(sequence.clips, ripplePlan.pushes)

  const clips = sequence.clips.map((c) => {
    if (c.id === clipId) return { ...c, startTime: clampedStart }
    if (linkedId && c.id === linkedId && !c.locked) return { ...c, startTime: Math.max(0, c.startTime + delta) }
    if (pushes.has(c.id)) return { ...c, startTime: pushes.get(c.id)! }
    return c
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Moves a clip to a new time AND a new (already-existing) track in one step
 * -- backs cross-track dragging. The linked partner (if any, e.g. this
 * clip's own A1 audio), still cascades by the same time delta only (when
 * `linked` is true), same as moveClip -- it never changes track just because
 * the clip it's linked to did. A no-op for a missing or locked clip. */
export function moveClipToTrack(sequence: ProjectSequence, clipId: string, newStartTime: number, trackId: string, linked = true): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence

  const clampedStart = Math.max(0, newStartTime)
  const linkedId = linked ? target.linkedClipId : undefined
  const delta = clampedStart - target.startTime
  // Same "stay here, make room" collision policy as moveClip, applied on
  // the DESTINATION track: a clip dropped onto another track lands in
  // front of or behind what is there (pushing the rest right), never on
  // top of it -- two clips overlapping on one track is never valid.
  const excludeIds = new Set([clipId, ...(linkedId ? [linkedId] : [])])
  const ripplePlan = planRippleInsert(sequence.clips, trackId, clampedStart, target.duration, excludeIds)
  const pushes = extendRippleInsertWithLinkedPartners(sequence.clips, ripplePlan.pushes)
  const clips = sequence.clips.map((c) => {
    if (c.id === clipId) return { ...c, startTime: clampedStart, trackId }
    if (linkedId && c.id === linkedId && !c.locked) return { ...c, startTime: Math.max(0, c.startTime + delta) }
    if (pushes.has(c.id)) return { ...c, startTime: pushes.get(c.id)! }
    return c
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Same as moveClipToTrack, but synthesizes a brand-new track of `kind`
 * first (matching the spec's "drop in empty space below the last track
 * auto-creates a track") -- one atomic transform so the new track and the
 * clip's move land in the same undo step. A no-op for a missing/locked clip.
 *
 * `explicitTrackId`, when given AND a track with that id already exists,
 * moves onto that existing track instead of creating another one -- this
 * makes repeated calls with the same `explicitTrackId` idempotent, which is
 * exactly what a single continuous drag gesture needs: the caller
 * pre-computes one id up front and passes it on every pointermove, so the
 * first call creates the track and every subsequent call (of which browsers
 * fire many per gesture) just moves onto the track already created, rather
 * than each independently synthesizing its own new track. */
export function moveClipToNewTrack(
  sequence: ProjectSequence,
  clipId: string,
  newStartTime: number,
  kind: TimelineTrackKind,
  linked = true,
  explicitTrackId?: string
): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const existing = explicitTrackId ? sequence.tracks.find((t) => t.id === explicitTrackId) : undefined
  if (existing) return moveClipToTrack(sequence, clipId, newStartTime, existing.id, linked)
  const tracks = addTrackToRegistry(sequence.tracks, kind, explicitTrackId)
  const newTrack = tracks[tracks.length - 1]
  return moveClipToTrack({ ...sequence, tracks }, clipId, newStartTime, newTrack.id, linked)
}

/** Removes a track and every clip that was on it. A clip whose linked
 * partner lives on a DIFFERENT track (the common case -- a video and its
 * own extracted/embedded audio) is untouched unless ITS track is the one
 * being removed too. A no-op if `trackId` doesn't exist or isn't removable
 * (see trackModel.removeTrack). Left in `sequence.clips` with a trackId no
 * longer in `sequence.tracks`, a removed track's clips would be permanently
 * invisible: unrenderable (nothing groups clips by a track id that no
 * longer exists), unselectable through any normal UI action, yet still
 * counted toward duration/export -- exactly what "Delete Track"'s own
 * confirmation dialog already promises removing but previously didn't.
 * Scenes (graphic/text track content) live in a separate context/state
 * tree keyed by mediaId, not trackId, so they can't be swept up here -- see
 * TimelineTrackHeaders.tsx's delete handler for that half. */
export function removeTrack(sequence: ProjectSequence, trackId: string): ProjectSequence {
  const tracks = removeTrackFromRegistry(sequence.tracks, trackId)
  if (tracks === sequence.tracks) return sequence
  // A surviving clip whose linkedClipId pointed at one of the just-removed
  // clips would otherwise keep a dangling reference (and its 🔗 badge) --
  // see sanitizeLinkedClips's own doc comment.
  const clips = sanitizeLinkedClips(sequence.clips.filter((c) => c.trackId !== trackId))
  return { ...sequence, tracks, clips, duration: computeSequenceDuration(clips) }
}

export type TrimEdge = 'left' | 'right'

/** Trims one clip's left or right edge to `pointerTime` (a project-absolute
 * second). Images: no source bound, minimum duration 0.1s, left trim moves
 * startTime+duration, right trim only changes duration. Video/audio: bounded
 * by `sourceDurationSeconds` (the underlying asset's real length) -- left
 * trim moves startTime/duration/sourceIn (sourceOut anchored), right trim
 * changes duration/sourceOut (startTime/sourceIn anchored). A no-op for a
 * missing or locked clip. */
export function trimClip(
  sequence: ProjectSequence,
  clipId: string,
  edge: TrimEdge,
  pointerTime: number,
  sourceDurationSeconds?: number,
  linked = true,
  partnerSourceDurationSeconds?: number
): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence

  // A plain (non-ripple) trim never grows a clip INTO its neighbour on the
  // same track: the edge stops at the previous clip's end / the next
  // clip's start. (Ripple trims -- ripple.ts -- move the neighbours
  // instead, so they don't come through here.)
  const linkedId = linked ? target.linkedClipId : undefined
  const partner = linkedId ? sequence.clips.find((c) => c.id === linkedId) : undefined
  if (partner?.locked) return sequence
  const partnerSourceLimit = partner ? partnerSourceDurationSeconds ?? sourceEnd(partner) : undefined
  let boundedPointerTime = clampTrimToNeighbours(sequence.clips, target, edge, pointerTime)
  // A still image has no source end -- its probed "duration" (a single
  // frame, ~0.04 s) must never cap it, or its right edge cannot be dragged
  // out at all. applyTrim already treats images this way; this pre-bound
  // used to apply the source length to them anyway.
  if (edge === 'right' && target.type !== 'image' && Number.isFinite(sourceDurationSeconds)) {
    boundedPointerTime = Math.min(boundedPointerTime, target.startTime + ((sourceDurationSeconds as number) - target.sourceIn) / clipRate(target))
  }
  if (partner && !partner.locked) {
    const partnerBound = clampTrimToNeighbours(sequence.clips, partner, edge, boundedPointerTime)
    boundedPointerTime = edge === 'left' ? Math.max(boundedPointerTime, partnerBound) : Math.min(boundedPointerTime, partnerBound)
    if (edge === 'left') {
      boundedPointerTime = Math.max(boundedPointerTime, target.startTime - target.sourceIn / clipRate(target), partner.startTime - partner.sourceIn / clipRate(partner))
    } else if (Number.isFinite(partnerSourceLimit)) {
      boundedPointerTime = Math.min(boundedPointerTime, partner.startTime + ((partnerSourceLimit as number) - partner.sourceIn) / clipRate(partner))
    }
  }

  const clips = sequence.clips.map((c) => (c.id === clipId ? applyTrim(c, edge, boundedPointerTime, sourceDurationSeconds) : c))

  // Linked partner (e.g. this clip's own A1 audio) gets the SAME edge
  // trimmed to the SAME pointerTime -- since both clips share one
  // sequence-absolute startTime baseline, this keeps them frame-synced
  // without needing separate per-clip source-duration bookkeeping here.
  // Gated behind `linked` (the Linkage toggle at the call site) same as
  // moveClip/moveClipToTrack.
  const finalClips = partner && !partner.locked ? clips.map((c) => (c.id === partner.id ? applyTrim(c, edge, boundedPointerTime, partnerSourceLimit) : c)) : clips

  return { ...sequence, clips: finalClips, duration: computeSequenceDuration(finalClips) }
}

/** The furthest `pointerTime` a trim of `edge` may reach before `clip`
 * would overlap the nearest other clip on its own track. */
export function clampTrimToNeighbours(clips: TimelineClip[], clip: TimelineClip, edge: TrimEdge, pointerTime: number): number {
  const others = clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
  if (edge === 'left') {
    const prevEnd = Math.max(-Infinity, ...others.filter((c) => c.startTime + c.duration <= clip.startTime + 1e-6).map((c) => c.startTime + c.duration))
    return Number.isFinite(prevEnd) ? Math.max(pointerTime, prevEnd) : pointerTime
  }
  const clipEnd = clip.startTime + clip.duration
  const nextStart = Math.min(Infinity, ...others.filter((c) => c.startTime >= clipEnd - 1e-6).map((c) => c.startTime))
  return Number.isFinite(nextStart) ? Math.min(pointerTime, nextStart) : pointerTime
}

/** Exported (not just used internally by trimClip) so ripple.ts's rippleTrim
 * can reuse the exact same trim math instead of duplicating it. */
export function applyTrim(clip: TimelineClip, edge: TrimEdge, pointerTime: number, sourceDurationSeconds?: number): TimelineClip {
  const isImage = clip.type === 'image'
  const clipEnd = clip.startTime + clip.duration

  if (edge === 'left') {
    let newStart = Math.min(pointerTime, clipEnd - MIN_CLIP_DURATION_SECONDS)
    newStart = Math.max(0, newStart)
    if (!isImage) {
      // Can't pull the start earlier than the source has frames available
      // before the current sourceIn.
      newStart = Math.max(newStart, clip.startTime - clip.sourceIn / clipRate(clip))
    }
    const deltaStart = newStart - clip.startTime
    return {
      ...clip,
      startTime: newStart,
      duration: clip.duration - deltaStart,
      sourceIn: isImage ? clip.sourceIn : clip.sourceIn + deltaStart * clipRate(clip)
    }
  }

  // right edge
  let newDuration = Math.max(MIN_CLIP_DURATION_SECONDS, pointerTime - clip.startTime)
  if (!isImage && Number.isFinite(sourceDurationSeconds)) {
    const maxDuration = Math.max(MIN_CLIP_DURATION_SECONDS, ((sourceDurationSeconds as number) - clip.sourceIn) / clipRate(clip))
    newDuration = Math.min(newDuration, maxDuration)
  }
  return {
    ...clip,
    duration: newDuration,
    sourceOut: isImage ? undefined : clip.sourceIn + newDuration * clipRate(clip)
  }
}

/** Splits one clip at `atTime` into two adjacent clips (per the exact
 * left/right formulas the user's spec gives). Images: `sourceOut` stays
 * undefined on the left piece, right piece's `sourceIn` is 0 (same still
 * image, independently editable from here on). Video/audio:
 * `sourceOut`/`sourceIn` computed from the split offset so source timing is
 * preserved across the cut. `linkedClipId` is cleared on both pieces;
 * splitClip reconnects matching pieces when a linked pair is split. */
export function splitOneClip(clips: TimelineClip[], clipId: string, atTime: number, makeId: IdFactory): TimelineClip[] {
  const idx = clips.findIndex((c) => c.id === clipId)
  if (idx === -1) return clips
  const clip = clips[idx]
  if (clip.locked) return clips

  const offset = atTime - clip.startTime
  if (offset <= 0 || offset >= clip.duration) return clips

  const isImage = clip.type === 'image'
  const leftClip: TimelineClip = {
    ...clip,
    id: makeId(),
    duration: offset,
    sourceOut: isImage ? undefined : clip.sourceIn + offset * clipRate(clip),
    linkedClipId: undefined
  }
  const rightClip: TimelineClip = {
    ...clip,
    id: makeId(),
    startTime: atTime,
    duration: clip.duration - offset,
    sourceIn: isImage ? 0 : clip.sourceIn + offset * clipRate(clip),
    linkedClipId: undefined
  }

  return [...clips.slice(0, idx), leftClip, rightClip, ...clips.slice(idx + 1)]
}

/** Split enabled only when the playhead is strictly inside the clip and the
 * clip isn't locked -- matches the guard the user's spec describes. */
export function canSplitClip(clip: TimelineClip | undefined, playheadTime: number): boolean {
  if (!clip || clip.locked) return false
  return playheadTime > clip.startTime && playheadTime < clip.startTime + clip.duration
}

export function splitClip(
  sequence: ProjectSequence,
  clipId: string,
  atTime: number,
  options: { linked?: boolean; makeId?: IdFactory } = {}
): ProjectSequence {
  const makeId = options.makeId ?? defaultMakeId
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!canSplitClip(target, atTime)) return sequence

  const splitLinked = options.linked ?? true
  const linkedTarget = splitLinked && target!.linkedClipId ? sequence.clips.find((c) => c.id === target!.linkedClipId) : undefined

  const newIds: string[] = []
  const trackedMakeId = (): string => {
    const id = makeId()
    newIds.push(id)
    return id
  }
  let clips = splitOneClip(sequence.clips, clipId, atTime, trackedMakeId)
  if (linkedTarget && canSplitClip(linkedTarget, atTime)) {
    clips = splitOneClip(clips, linkedTarget.id, atTime, trackedMakeId)
    const [leftId, rightId, linkedLeftId, linkedRightId] = newIds
    clips = clips.map((c) => {
      if (c.id === leftId) return { ...c, linkedClipId: linkedLeftId }
      if (c.id === rightId) return { ...c, linkedClipId: linkedRightId }
      if (c.id === linkedLeftId) return { ...c, linkedClipId: leftId }
      if (c.id === linkedRightId) return { ...c, linkedClipId: rightId }
      return c
    })
  }
  return { ...sequence, clips: sanitizeLinkedClips(clips), duration: computeSequenceDuration(clips) }
}

/** Removes every clip whose id is in `clipIds` and is not locked. When
 * `linked` (default true), each target's linked partner (if unlocked) is
 * deleted too, even if it wasn't itself in `clipIds` -- gated by the
 * Linkage toggle at the call site (see SequenceContext.deleteSelected).
 * Locked clips are left untouched (never silently deleted), whether they
 * were an explicit target or pulled in as a partner. */
export function deleteClips(sequence: ProjectSequence, clipIds: string[], linked = true): ProjectSequence {
  const idSet = new Set(clipIds)
  if (linked) {
    for (const c of sequence.clips) {
      if (idSet.has(c.id) && c.linkedClipId) idSet.add(c.linkedClipId)
    }
  }
  // A LOCKED partner is deliberately never added to the removal set above
  // (see this function's own filter just below), so it can survive its
  // now-deleted target -- still with a `linkedClipId` pointing at a clip
  // that no longer exists. sanitizeLinkedClips clears that dangling
  // reference (and the 🔗 badge it would otherwise keep showing) in this
  // same returned snapshot, so Undo still restores the original pairing.
  const clips = sanitizeLinkedClips(sequence.clips.filter((c) => !(idSet.has(c.id) && !c.locked)))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

export interface TimeRange {
  start: number
  end: number
}

/** Range tool's "Delete Range" / "Ripple Delete Range" (spec section 4/9) --
 * removes whatever every unlocked clip on every track has within
 * [range.start, range.end), across the whole sequence (not scoped to a
 * selection). Clips are first split at both range boundaries (reusing
 * splitOneClip's exact math, so partial overlaps become clean pieces), then
 * every resulting clip now fully inside the range is deleted, leaving a real
 * gap. `ripple: true` additionally closes that gap on every track
 * afterward (via reflow.ts's closeGap), pulling later clips left. */
export function deleteTimeRange(sequence: ProjectSequence, range: TimeRange, ripple = false, makeId: IdFactory = defaultMakeId): ProjectSequence {
  if (range.end <= range.start) return sequence

  let clips = sequence.clips
  for (const boundary of [range.start, range.end]) {
    // Re-scan the CURRENT (possibly already-split-once) clips array for each
    // boundary -- a clip spanning the whole range needs splitting at BOTH
    // ends, and after the first split the original clip id no longer exists.
    const straddling = clips.filter((c) => !c.locked && boundary > c.startTime + 1e-9 && boundary < c.startTime + c.duration - 1e-9)
    for (const clip of straddling) {
      clips = splitOneClip(clips, clip.id, boundary, makeId)
    }
  }

  clips = clips.filter((c) => c.locked || !(c.startTime >= range.start - 1e-6 && c.startTime + c.duration <= range.end + 1e-6))

  if (ripple) {
    const trackIds = [...new Set(sequence.tracks.map((t) => t.id))]
    for (const trackId of trackIds) {
      clips = closeGap(clips, trackId, range.start, range.end)
    }
  }

  clips = sanitizeLinkedClips(clips)
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Duplicates each given clip, placed right after ITS OWN current end (not
 * bunched at one point). When `linked` (default true), a target's linked
 * partner is pulled into the duplicate set too if it wasn't already there
 * (gated by the Linkage toggle at the call site) -- so duplicating just the
 * video half of a pair also duplicates its audio, keeping the copies linked
 * to each other. Returns the new clip ids so the caller can select them. */
export function duplicateClips(sequence: ProjectSequence, clipIds: string[], makeId: IdFactory = defaultMakeId, linked = true): { sequence: ProjectSequence; newClipIds: string[] } {
  const idSet = new Set(clipIds)
  if (linked) {
    for (const c of sequence.clips) {
      if (idSet.has(c.id) && c.linkedClipId) idSet.add(c.linkedClipId)
    }
  }
  const originals = sequence.clips.filter((c) => idSet.has(c.id))
  if (originals.length === 0) return { sequence, newClipIds: [] }

  const idMap = new Map<string, string>()
  for (const c of originals) idMap.set(c.id, makeId())

  const copies = originals.map((c) => ({
    ...c,
    id: idMap.get(c.id)!,
    startTime: c.startTime + c.duration,
    locked: false,
    linkedClipId: c.linkedClipId && idMap.has(c.linkedClipId) ? idMap.get(c.linkedClipId) : undefined
  }))

  const clips = [...sequence.clips, ...copies]
  return { sequence: { ...sequence, clips, duration: computeSequenceDuration(clips) }, newClipIds: copies.map((c) => c.id) }
}

/** Toggles `locked` on the given clips (does not cascade to linked clips --
 * locking is intentionally per-clip). */
export function setClipsLocked(sequence: ProjectSequence, clipIds: string[], locked: boolean): ProjectSequence {
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) ? { ...c, locked } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

export function setClipsMuted(sequence: ProjectSequence, clipIds: string[], muted: boolean): ProjectSequence {
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) ? { ...c, muted } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** The subset of TimelineClip's fields "Paste Attributes" (Ctrl+Shift+V,
 * spec section 10) copies -- appearance/speed/audio properties, never
 * timing/track/media/link identity. Includes `keyframes` so pasting a
 * keyframed clip's attributes onto another carries its animation too,
 * consistent with every other appearance property here. */
export type ClipPropertyPatch = Partial<Pick<TimelineClip, 'playbackRate' | 'opacity' | 'volume' | 'fadeIn' | 'fadeOut' | 'transform' | 'keyframes' | 'motion'>>

export function pickClipProperties(clip: TimelineClip): ClipPropertyPatch {
  return {
    playbackRate: clip.playbackRate,
    opacity: clip.opacity,
    volume: clip.volume,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    transform: clip.transform,
    keyframes: clip.keyframes,
    motion: clip.motion
  }
}

/** Applies a property patch (not timing) to every given unlocked clip --
 * backs both "Paste Attributes" and the Clip Properties panel's own field
 * edits. */
export function applyClipProperties(sequence: ProjectSequence, clipIds: string[], patch: ClipPropertyPatch): ProjectSequence {
  const idSet = new Set(clipIds)
  const speedChanged = patch.playbackRate !== undefined
  const speedSet = new Set<string>()
  if (speedChanged) {
    const blockedByLockedClip = (clip: TimelineClip): boolean => {
      const nextDuration = Math.max(MIN_CLIP_DURATION_SECONDS, (sourceEnd(clip) - clip.sourceIn) / clipRate({ ...clip, playbackRate: patch.playbackRate }))
      if (nextDuration <= clip.duration) return false
      return sequence.clips.some((other) => other.id !== clip.id && other.trackId === clip.trackId && other.locked && other.startTime < clip.startTime + nextDuration && other.startTime + other.duration > clip.startTime + clip.duration)
    }
    for (const clip of sequence.clips) {
      if (!idSet.has(clip.id) || clip.locked || clip.type === 'image') continue
      const partner = sequence.clips.find((c) => c.id === clip.linkedClipId)
      if (partner?.locked || blockedByLockedClip(clip) || (partner && blockedByLockedClip(partner))) continue
      speedSet.add(clip.id)
      if (partner) speedSet.add(partner.id)
    }
  }
  let clips = sequence.clips.map((c) => {
    const selected = idSet.has(c.id) && !c.locked
    const retime = speedSet.has(c.id) && c.type !== 'image'
    if (!selected && !retime) return c
    const properties = selected ? { ...c, ...patch } : { ...c, playbackRate: patch.playbackRate }
    if (!retime) return speedChanged ? { ...properties, playbackRate: c.playbackRate } : properties
    const sourceWindow = Math.max(0, sourceEnd(c) - c.sourceIn)
    return { ...properties, sourceOut: sourceEnd(c), duration: Math.max(MIN_CLIP_DURATION_SECONDS, sourceWindow / clipRate(properties)) }
  })
  // Slowing a clip down makes it longer. Make room on its own track and
  // carry any pushed clip's linked partner along, just like an insert.
  for (const original of sequence.clips) {
    const changed = clips.find((c) => c.id === original.id)
    if (!changed || changed.duration <= original.duration + 1e-6) continue
    const exclude = new Set([changed.id, ...(changed.linkedClipId ? [changed.linkedClipId] : [])])
    const plan = planRippleInsert(clips, changed.trackId, changed.startTime, changed.duration, exclude)
    const pushes = extendRippleInsertWithLinkedPartners(clips, plan.pushes)
    clips = clips.map((c) => pushes.has(c.id) ? { ...c, startTime: pushes.get(c.id)! } : c)
  }
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** "Reset Attributes" (clip context menu) -- same shape as "Paste
 * Attributes" (applyClipProperties), but the patch is always every
 * ClipPropertyPatch field cleared back to its un-adjusted default (playback
 * speed 1x, full opacity/volume, no fades, identity transform) instead of a
 * copied clip's values. Never touches timing/track/media/link identity,
 * same as applyClipProperties. */
export function resetClipProperties(sequence: ProjectSequence, clipIds: string[]): ProjectSequence {
  return applyClipProperties(sequence, clipIds, {
    playbackRate: 1,
    opacity: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: undefined,
    keyframes: undefined,
    motion: undefined
  })
}

const DURATION_INPUT_PATTERN = /^\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s?)?\s*$/i

/** Parses a Clip Properties duration field: "5s", "30s", "1m", "2m 30s", or
 * a bare number of seconds ("5", "5.5"). Returns null for anything that
 * doesn't parse as a positive duration (the caller should leave the field
 * unchanged rather than apply a garbage value). */
export function parseDurationInput(text: string): number | null {
  const match = DURATION_INPUT_PATTERN.exec(text)
  if (!match || (!match[1] && !match[2])) return null
  const minutes = match[1] ? parseFloat(match[1]) : 0
  const seconds = match[2] ? parseFloat(match[2]) : 0
  const total = minutes * 60 + seconds
  return total > 0 ? total : null
}

/** THE resolver Project Preview uses: every clip active at `currentTime`,
 * across every track, in clip array order. A clip is active on
 * `[startTime, startTime + duration)` -- a half-open interval, so back-to-back
 * clips never both read as active at their shared boundary instant. A
 * Disabled clip (`enabled === false`, see the Enable/Disable clip-context-
 * menu command) is excluded from playback but stays in the clip array. */
export function findActiveClips(sequence: ProjectSequence, currentTime: number): TimelineClip[] {
  return sequence.clips.filter((c) => c.enabled !== false && currentTime >= c.startTime && currentTime < c.startTime + c.duration)
}

/** Moves every clip in `clipIds` by the SAME `deltaSeconds`, preserving
 * their relative offsets from each other (multi-select drag) -- locked
 * clips in the set are skipped individually rather than blocking the whole
 * move. Does not cascade to linked partners itself; the caller
 * (SequenceContext) is expected to have already expanded `clipIds` to
 * include linked partners via resolveMoveSet if that's desired for this
 * drag. Clamps every moved clip's startTime to >= 0 independently (not by a
 * single shared clamp), so a multi-select drag that would push one clip
 * negative doesn't distort the others' relative spacing by clamping them
 * all to the same amount -- each clip simply stops at 0 on its own. */
export function moveClips(sequence: ProjectSequence, clipIds: string[], deltaSeconds: number): ProjectSequence {
  if (deltaSeconds === 0) return sequence
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) && !c.locked ? { ...c, startTime: Math.max(0, c.startTime + deltaSeconds) } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** The full set of clip ids a drag on `clickedClipId` should move together:
 * always includes every id already in `selectedClipIds` (a multi-select
 * drag moves the whole selection, not just the clip under the pointer) plus
 * `clickedClipId` itself, then every clip sharing a `groupId` with any of
 * those (groups always move together regardless of Linkage), then --
 * ONLY if `linkageOn` -- each of those clips' own `linkedClipId` partner.
 * Used by ClipTrack's drag handler to compute the ghost/ripple set once per
 * drag start. */
export function resolveMoveSet(clips: TimelineClip[], clickedClipId: string, selectedClipIds: string[], linkageOn: boolean): string[] {
  const byId = new Map(clips.map((c) => [c.id, c] as const))
  const moveSet = new Set<string>(selectedClipIds.includes(clickedClipId) ? selectedClipIds : [clickedClipId])

  // Expand to every clip sharing a groupId with anything already in the set.
  let grew = true
  while (grew) {
    grew = false
    const groupIds = new Set([...moveSet].map((id) => byId.get(id)?.groupId).filter((g): g is string => Boolean(g)))
    if (groupIds.size === 0) break
    for (const c of clips) {
      if (c.groupId && groupIds.has(c.groupId) && !moveSet.has(c.id)) {
        moveSet.add(c.id)
        grew = true
      }
    }
  }

  if (linkageOn) {
    for (const id of [...moveSet]) {
      const linkedId = byId.get(id)?.linkedClipId
      if (linkedId) moveSet.add(linkedId)
    }
  }

  return [...moveSet]
}

/** Drag a selection/group as one unit. An external neighbour blocks the
 * entire set, keeping every clip at the same relative offset and avoiding
 * accidental overlaps or a partial move of a linked pair. */
export function moveClipSet(sequence: ProjectSequence, clickedClipId: string, selectedClipIds: string[], newStartTime: number, linkageOn: boolean): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clickedClipId)
  if (!target) return sequence
  const ids = new Set(resolveMoveSet(sequence.clips, clickedClipId, selectedClipIds, linkageOn))
  if (ids.size <= 1) return moveClip(sequence, clickedClipId, newStartTime, linkageOn)
  const delta = clampClipSetDelta(sequence.clips, [...ids], newStartTime - target.startTime)
  if (Math.abs(delta) < 1e-6) return sequence
  const clips = sequence.clips.map((c) => ids.has(c.id) ? { ...c, startTime: c.startTime + delta } : c)
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

export function clampClipSetDelta(clips: TimelineClip[], clipIds: string[], requestedDelta: number): number {
  const ids = new Set(clipIds)
  const moving = clips.filter((c) => ids.has(c.id))
  if (moving.length === 0 || moving.some((c) => c.locked)) return 0
  let delta = requestedDelta
  delta = Math.max(delta, -Math.min(...moving.map((c) => c.startTime)))
  for (const clip of moving) {
    const others = clips.filter((c) => c.trackId === clip.trackId && !ids.has(c.id))
    if (delta > 0) {
      const next = Math.min(Infinity, ...others.filter((c) => c.startTime >= clip.startTime + clip.duration - 1e-6).map((c) => c.startTime))
      if (Number.isFinite(next)) delta = Math.min(delta, next - clip.startTime - clip.duration)
    } else if (delta < 0) {
      const previous = Math.max(-Infinity, ...others.filter((c) => c.startTime + c.duration <= clip.startTime + 1e-6).map((c) => c.startTime + c.duration))
      if (Number.isFinite(previous)) delta = Math.max(delta, previous - clip.startTime)
    }
  }
  return delta
}

/** Enable/Disable (clip context menu) -- see findActiveClips. Locked clips
 * are still toggleable (unlike lock itself, this doesn't gate editing). */
export function setClipsEnabled(sequence: ProjectSequence, clipIds: string[], enabled: boolean): ProjectSequence {
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) ? { ...c, enabled } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Explicit "Link Selected Clips" -- links exactly two clips as a video<->
 * audio pair (overwriting any previous `linkedClipId` either side had). A
 * no-op if either clip is missing or they're already linked to each other. */
export function linkClips(sequence: ProjectSequence, clipIdA: string, clipIdB: string): ProjectSequence {
  const a = sequence.clips.find((c) => c.id === clipIdA)
  const b = sequence.clips.find((c) => c.id === clipIdB)
  if (!a || !b) return sequence
  if (a.linkedClipId === clipIdB && b.linkedClipId === clipIdA) return sequence
  const clips = sequence.clips.map((c) => {
    if (c.id === clipIdA) return { ...c, linkedClipId: clipIdB }
    if (c.id === clipIdB) return { ...c, linkedClipId: clipIdA }
    return c
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Explicit "Unlink Selected Clips" -- clears `linkedClipId` on `clipId` AND
 * on whichever clip currently points back at it (so a stale one-directional
 * link can never remain). */
export function unlinkClips(sequence: ProjectSequence, clipId: string): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target?.linkedClipId) return sequence
  const partnerId = target.linkedClipId
  const clips = sequence.clips.map((c) => {
    if (c.id === clipId || c.id === partnerId) return { ...c, linkedClipId: undefined }
    return c
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Explicit "Relink Original Audio" -- re-links `clipId` (typically a video
 * clip that was Unlinked, or split, and now stands alone) to the OTHER clip
 * in the sequence that shares its `mediaId`, is the opposite type
 * (video<->audio), currently has no link of its own, and starts at the same
 * time (the two pieces that came from the same original import, still
 * time-aligned) -- the closest-in-time such candidate if more than one
 * matches. A no-op if `clipId` is missing or no such candidate exists. */
export function relinkOriginalAudio(sequence: ProjectSequence, clipId: string): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target) return sequence
  const wantType = target.type === 'audio' ? 'video' : target.type === 'video' ? 'audio' : undefined
  if (!wantType) return sequence

  const candidates = sequence.clips.filter((c) => c.id !== clipId && c.mediaId === target.mediaId && c.type === wantType && !c.linkedClipId)
  if (candidates.length === 0) return sequence
  candidates.sort((a, b) => Math.abs(a.startTime - target.startTime) - Math.abs(b.startTime - target.startTime))
  return linkClips(sequence, clipId, candidates[0].id)
}

/** "Extract to Audio" -- splits a standalone audio clip out of a video
 * clip's own embedded audio, onto `trackId` (an audio track the caller has
 * already resolved via findOrCreateTrack, creating one if needed). Matches
 * the video clip's CURRENT startTime/duration/sourceIn/sourceOut exactly
 * (whatever trimming has already happened, not the source asset's full
 * length), and links the two together -- same shape as the V+A pair an
 * import with audio produces (see buildInsertedClips). A no-op if the clip
 * is missing, isn't a video, or already has a linked clip (nothing to
 * extract into -- it's either already split out or linked to something
 * else). */
export function extractAudio(sequence: ProjectSequence, clipId: string, trackId: string, makeId: IdFactory = defaultMakeId): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.type !== 'video' || target.linkedClipId) return sequence

  const audioId = makeId()
  const audioClip: TimelineClip = {
    id: audioId,
    mediaId: target.mediaId,
    type: 'audio',
    trackId,
    startTime: target.startTime,
    duration: target.duration,
    sourceIn: target.sourceIn,
    sourceOut: target.sourceOut,
    playbackRate: target.playbackRate,
    linkedClipId: clipId,
    locked: false
  }
  const clips = sequence.clips.map((c) => (c.id === clipId ? { ...c, linkedClipId: audioId } : c)).concat(audioClip)
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** "Select Linked Clips" -- extends a selection to include every selected
 * clip's own `linkedClipId` partner (already-included partners are a no-op,
 * via the Set). */
export function selectedWithLinkedClips(clips: TimelineClip[], selectedClipIds: string[]): string[] {
  const byId = new Map(clips.map((c) => [c.id, c] as const))
  const result = new Set(selectedClipIds)
  for (const id of selectedClipIds) {
    const linkedId = byId.get(id)?.linkedClipId
    if (linkedId) result.add(linkedId)
  }
  return [...result]
}

/** Arbitrary N-clip "move together" grouping (Ctrl+G), independent of
 * linkedClipId -- see TimelineClip.groupId's doc comment for why these are
 * two separate concepts. Always creates a fresh groupId, even if some of
 * the given clips were already in a (now-abandoned) group. Fewer than 2
 * clips is a no-op (nothing meaningful to group). */
export function groupClips(sequence: ProjectSequence, clipIds: string[], makeId: IdFactory = defaultMakeId): ProjectSequence {
  if (clipIds.length < 2) return sequence
  const idSet = new Set(clipIds)
  const groupId = makeId()
  const clips = sequence.clips.map((c) => (idSet.has(c.id) ? { ...c, groupId } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Ctrl+Shift+G -- clears `groupId` on every given clip. */
export function ungroupClips(sequence: ProjectSequence, clipIds: string[]): ProjectSequence {
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) ? { ...c, groupId: undefined } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** "Move to Track" (clip context menu) -- reassigns `trackId` in place,
 * preserving startTime/duration/sourceIn/sourceOut exactly (the caller is
 * responsible for only offering compatible tracks -- e.g. video clips onto
 * kind:'video' tracks -- this function itself doesn't validate kind
 * compatibility, matching the rest of this module's "caller decides
 * validity, this just applies it" convention). */
export function moveClipsToTrack(sequence: ProjectSequence, clipIds: string[], trackId: string): ProjectSequence {
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) && !c.locked ? { ...c, trackId } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** "Replace Media" (clip context menu) -- swaps which MediaSource a clip
 * points at, resetting sourceIn to 0 and clamping duration/sourceOut to the
 * new source's own length (never longer than what the replacement asset
 * actually has). Image clips are untouched by the duration clamp (never
 * source-bounded). A no-op for a missing or locked clip. */
/** Sets exact start times on many clips at once, with NO collision or
 * ripple handling. AI Dubber's Auto-Sync uses this to put every generated
 * line back on its own subtitle's timestamp: the caller already knows
 * precisely where each clip belongs, and moveClip's gap-aware rippling
 * would fight that by pushing the very clips being positioned. Locked clips
 * are left alone, same as every other mutator here. */
export function setClipStartTimes(sequence: ProjectSequence, updates: { clipId: string; startTime: number }[]): ProjectSequence {
  if (updates.length === 0) return sequence
  const byId = new Map(updates.map((u) => [u.clipId, Math.max(0, u.startTime)]))
  const clips = sequence.clips.map((c) => {
    const next = byId.get(c.id)
    return next === undefined || c.locked ? c : { ...c, startTime: next }
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Points a clip at another file of the same sound (an Audio Effects
 * render, or back to the original), keeping its place and length. */
export function setClipAudioSource(
  sequence: ProjectSequence,
  clipId: string,
  patch: { mediaId: string; sourceIn: number; sourceOut: number; audioEffect: TimelineClip['audioEffect'] }
): ProjectSequence {
  return {
    ...sequence,
    clips: sequence.clips.map((c) => {
      if (c.id !== clipId || c.locked) return c
      const { audioEffect: _old, ...rest } = c
      return { ...rest, mediaId: patch.mediaId, sourceIn: patch.sourceIn, sourceOut: patch.sourceOut, ...(patch.audioEffect ? { audioEffect: patch.audioEffect } : {}) }
    })
  }
}

export function replaceClipMedia(sequence: ProjectSequence, clipId: string, newMediaId: string, newSourceDurationSeconds: number): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const clips = sequence.clips.map((c) => {
    if (c.id !== clipId) return c
    if (c.type === 'image') return { ...c, mediaId: newMediaId, sourceIn: 0, sourceOut: undefined }
    const duration = Math.min(c.duration, Math.max(MIN_CLIP_DURATION_SECONDS, newSourceDurationSeconds / clipRate(c)))
    return { ...c, mediaId: newMediaId, sourceIn: 0, sourceOut: duration * clipRate(c), duration }
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

// ---- Sequence-level markers (spec section 16) ----

export function addMarker(sequence: ProjectSequence, time: number, makeId: IdFactory = defaultMakeId): ProjectSequence {
  const marker: Marker = { id: makeId(), time: Math.max(0, time), color: '#5b8cff', name: 'Marker' }
  return { ...sequence, markers: [...sequence.markers, marker].sort((a, b) => a.time - b.time) }
}

export function moveMarker(sequence: ProjectSequence, markerId: string, newTime: number): ProjectSequence {
  const markers = sequence.markers
    .map((m) => (m.id === markerId ? { ...m, time: Math.max(0, newTime) } : m))
    .sort((a, b) => a.time - b.time)
  return { ...sequence, markers }
}

export function updateMarker(sequence: ProjectSequence, markerId: string, patch: Partial<Pick<Marker, 'name' | 'note' | 'color'>>): ProjectSequence {
  const markers = sequence.markers.map((m) => (m.id === markerId ? { ...m, ...patch } : m))
  return { ...sequence, markers }
}

export function removeMarker(sequence: ProjectSequence, markerId: string): ProjectSequence {
  return { ...sequence, markers: sequence.markers.filter((m) => m.id !== markerId) }
}

// ---- Per-clip markers (travel with the clip, see TimelineClip.markers) ----

export function addClipMarker(sequence: ProjectSequence, clipId: string, offsetSeconds: number, makeId: IdFactory = defaultMakeId): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target) return sequence
  const clampedOffset = Math.max(0, Math.min(target.duration, offsetSeconds))
  const clips = sequence.clips.map((c) =>
    c.id === clipId ? { ...c, markers: [...(c.markers ?? []), { id: makeId(), offsetSeconds: clampedOffset, color: '#5b8cff', name: 'Marker' }] } : c
  )
  return { ...sequence, clips }
}

export function removeClipMarker(sequence: ProjectSequence, clipId: string, markerId: string): ProjectSequence {
  const clips = sequence.clips.map((c) => (c.id === clipId ? { ...c, markers: (c.markers ?? []).filter((m) => m.id !== markerId) } : c))
  return { ...sequence, clips }
}

// ---- Keyframe animation (see shared/keyframes.ts) -- one array per
// keyframeable property, keyed on TimelineClip.keyframes. Same
// locked-clip guard as applyClipProperties: a locked clip's animation
// can't be edited any more than its other properties can. ----

/** Adds a new keyframe for `property` at `time` (clamped to the clip's own
 * [0, duration] range, matching addClipMarker's own clamping), or -- if one
 * already sits at that exact clamped time -- overwrites its value/easing
 * instead of creating a duplicate. This is what backs both "seed the first
 * keyframe from the current static value" and "add/update a keyframe at the
 * playhead" from the Clip Properties panel. */
export function addOrUpdateKeyframe(
  sequence: ProjectSequence,
  clipId: string,
  property: KeyframeableProperty,
  time: number,
  value: number,
  easing?: KeyframeEasing,
  makeId: IdFactory = defaultMakeId
): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const clampedTime = Math.max(0, Math.min(target.duration, time))
  const existingForProperty = target.keyframes?.[property] ?? []
  const existingAtTime = existingForProperty.find((k) => k.time === clampedTime)
  const nextForProperty = existingAtTime
    ? existingForProperty.map((k) => (k.id === existingAtTime.id ? { ...k, value, easing } : k))
    : [...existingForProperty, { id: makeId(), time: clampedTime, value, easing }]
  const clips = sequence.clips.map((c) => (c.id === clipId ? { ...c, keyframes: { ...c.keyframes, [property]: nextForProperty } } : c))
  return { ...sequence, clips }
}

/** Repositions one keyframe in time (dragging its diamond marker on the
 * Timeline) -- clamped to the clip's own [0, duration] range, same as
 * addOrUpdateKeyframe. Never changes its value/easing. */
export function moveKeyframe(sequence: ProjectSequence, clipId: string, property: KeyframeableProperty, keyframeId: string, newTime: number): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const clampedTime = Math.max(0, Math.min(target.duration, newTime))
  const existingForProperty = target.keyframes?.[property] ?? []
  const nextForProperty = existingForProperty.map((k) => (k.id === keyframeId ? { ...k, time: clampedTime } : k))
  const clips = sequence.clips.map((c) => (c.id === clipId ? { ...c, keyframes: { ...c.keyframes, [property]: nextForProperty } } : c))
  return { ...sequence, clips }
}

/** Deletes one keyframe (the clip context menu's "Delete Keyframe"). Down to
 * 0 or 1 remaining keyframes for that property, the property simply reads
 * as a constant (or falls back to its plain static field at 0) -- see
 * interpolateKeyframes -- no special-casing needed here. */
export function removeKeyframe(sequence: ProjectSequence, clipId: string, property: KeyframeableProperty, keyframeId: string): ProjectSequence {
  const clips = sequence.clips.map((c) => {
    if (c.id !== clipId || c.locked || !c.keyframes?.[property]) return c
    return { ...c, keyframes: { ...c.keyframes, [property]: c.keyframes[property]!.filter((k) => k.id !== keyframeId) } }
  })
  return { ...sequence, clips }
}

/** "Remove Vocal": the instrumental -- a whole-file copy of the video's own
 * sound -- under each of these video clips, cut and timed exactly like the
 * clip above it (same place and length on the Timeline, same point in the
 * file, same speed), with the clip's own sound (and a linked audio
 * partner's) muted. A clip cut and slowed by Video Sync, starting partway
 * into the file, therefore still lines up. One sequence change: one Undo. */
export function addMirroredAudioClips(sequence: ProjectSequence, videoClipIds: string[], audioMediaId: string, makeId: IdFactory = defaultMakeId): ProjectSequence {
  let tracks = sequence.tracks
  const added: TimelineClip[] = []
  const mute = new Set<string>()
  for (const id of videoClipIds) {
    const video = sequence.clips.find((c) => c.id === id && c.type === 'video')
    if (!video) continue
    // Already has it (Remove Vocal pressed again): nothing to add twice.
    const has = (c: TimelineClip): boolean => c.mediaId === audioMediaId && Math.abs(c.startTime - video.startTime) < 1e-6 && Math.abs(c.sourceIn - video.sourceIn) < 1e-6
    if (sequence.clips.some(has)) {
      mute.add(video.id)
      continue
    }
    const occupied: OccupiedRange[] = [...sequence.clips, ...added].map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
    const routing = findOrCreateTrack(tracks, occupied, video.startTime, video.duration, 'audio')
    if (routing.newTrack) tracks = ensureTrack(tracks, routing.newTrack)
    added.push({
      id: makeId(),
      mediaId: audioMediaId,
      type: 'audio',
      trackId: routing.trackId,
      startTime: video.startTime,
      duration: video.duration,
      sourceIn: video.sourceIn,
      sourceOut: video.sourceOut,
      locked: false,
      ...(video.playbackRate !== undefined && video.playbackRate !== 1 ? { playbackRate: video.playbackRate } : {})
    })
    mute.add(video.id)
    if (video.linkedClipId) mute.add(video.linkedClipId)
  }
  if (added.length === 0 && !sequence.clips.some((c) => mute.has(c.id) && !c.muted)) return sequence
  const clips = [...sequence.clips.map((c) => (mute.has(c.id) ? { ...c, muted: true } : c)), ...added]
  return { ...sequence, tracks, clips, duration: computeSequenceDuration(clips) }
}
