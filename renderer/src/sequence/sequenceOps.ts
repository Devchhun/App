// Pure, deterministic operations on a ProjectSequence -- every export here
// is a pure function (sequence/clip in, new sequence/clip out), no React, no
// DOM, no Date.now()/random ids baked into the math (id generation is the
// one exception, isolated to insert/split/duplicate, and swappable in tests
// via the `makeId` param). This is the single source of truth for how
// clips get inserted, moved, trimmed, split, deleted, and duplicated --
// SequenceContext.tsx only wires these into React state + undo/redo
// transactions, it doesn't reimplement any of this math.
import type { ProjectSequence, TimelineClip, Marker } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import type { TimelineTrackKind } from '@shared/timelineTracks'
import { addTrack as addTrackToRegistry } from '../timeline/trackModel'
import { closeGap } from '../timeline/reflow'

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
  hasAudio?: boolean
}

/** Builds the clip(s) a freshly-inserted asset becomes, per the insertion
 * rules: video gets a full-source V1 clip (+ a linked A1 clip if it has
 * audio), image gets a fixed 5s V1 clip (`sourceOut` stays undefined --
 * never source-bounded), audio gets a full-source clip on the given track. */
export function buildInsertedClips(asset: InsertableAsset, atTime: number, trackId: string, makeId: IdFactory = defaultMakeId): TimelineClip[] {
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
        locked: false
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
        locked: false
      }
    ]
  }

  const videoId = makeId()
  const videoClip: TimelineClip = {
    id: videoId,
    mediaId: asset.mediaId,
    type: 'video',
    trackId,
    startTime,
    duration: asset.sourceDurationSeconds,
    sourceIn: 0,
    sourceOut: asset.sourceDurationSeconds,
    locked: false
  }
  if (!asset.hasAudio) return [videoClip]

  const audioId = makeId()
  videoClip.linkedClipId = audioId
  const audioClip: TimelineClip = {
    id: audioId,
    mediaId: asset.mediaId,
    type: 'audio',
    trackId: 'A1',
    startTime,
    duration: asset.sourceDurationSeconds,
    sourceIn: 0,
    sourceOut: asset.sourceDurationSeconds,
    linkedClipId: videoId,
    locked: false
  }
  return [videoClip, audioClip]
}

export function insertClip(
  sequence: ProjectSequence,
  asset: InsertableAsset,
  atTime: number,
  trackId: string,
  makeId: IdFactory = defaultMakeId
): ProjectSequence {
  const inserted = buildInsertedClips(asset, atTime, trackId, makeId)
  const clips = [...sequence.clips, ...inserted]
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Moves a clip so its startTime becomes `newStartTime` (clamped >= 0).
 * Its linked clip (video <-> audio), if any and unlocked, moves by the same
 * delta so they stay in sync -- but ONLY when `linked` is true (default),
 * gated by the Timeline's Linkage toggle at the call site (see
 * SequenceContext.moveClip). A no-op (same reference back) for a missing
 * or locked clip. */
export function moveClip(sequence: ProjectSequence, clipId: string, newStartTime: number, linked = true): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence

  const clampedStart = Math.max(0, newStartTime)
  const delta = clampedStart - target.startTime
  if (delta === 0) return sequence

  const linkedId = linked ? target.linkedClipId : undefined
  const clips = sequence.clips.map((c) => {
    if (c.id === clipId) return { ...c, startTime: clampedStart }
    if (linkedId && c.id === linkedId && !c.locked) return { ...c, startTime: Math.max(0, c.startTime + delta) }
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
  const clips = sequence.clips.map((c) => {
    if (c.id === clipId) return { ...c, startTime: clampedStart, trackId }
    if (linkedId && c.id === linkedId && !c.locked) return { ...c, startTime: Math.max(0, c.startTime + delta) }
    return c
  })
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Same as moveClipToTrack, but synthesizes a brand-new track of `kind`
 * first (matching the spec's "drop in empty space below the last track
 * auto-creates a track") -- one atomic transform so the new track and the
 * clip's move land in the same undo step. A no-op for a missing/locked clip. */
export function moveClipToNewTrack(sequence: ProjectSequence, clipId: string, newStartTime: number, kind: TimelineTrackKind, linked = true): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const tracks = addTrackToRegistry(sequence.tracks, kind)
  const newTrack = tracks[tracks.length - 1]
  return moveClipToTrack({ ...sequence, tracks }, clipId, newStartTime, newTrack.id, linked)
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
  linked = true
): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence

  const clips = sequence.clips.map((c) => (c.id === clipId ? applyTrim(c, edge, pointerTime, sourceDurationSeconds) : c))

  // Linked partner (e.g. this clip's own A1 audio) gets the SAME edge
  // trimmed to the SAME pointerTime -- since both clips share one
  // sequence-absolute startTime baseline, this keeps them frame-synced
  // without needing separate per-clip source-duration bookkeeping here.
  // Gated behind `linked` (the Linkage toggle at the call site) same as
  // moveClip/moveClipToTrack.
  // Known limitation: the partner's own source-duration bound isn't passed
  // in (the caller only has the PRIMARY clip's), so a right-edge trim that
  // EXTENDS past the partner's real source length isn't clamped here --
  // left-edge trims and any shortening are always safe regardless.
  const linkedId = linked ? target.linkedClipId : undefined
  const partner = linkedId ? sequence.clips.find((c) => c.id === linkedId) : undefined
  const finalClips = partner && !partner.locked ? clips.map((c) => (c.id === partner.id ? applyTrim(c, edge, pointerTime) : c)) : clips

  return { ...sequence, clips: finalClips, duration: computeSequenceDuration(finalClips) }
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
      newStart = Math.max(newStart, clip.startTime - clip.sourceIn)
    }
    const deltaStart = newStart - clip.startTime
    return {
      ...clip,
      startTime: newStart,
      duration: clip.duration - deltaStart,
      sourceIn: isImage ? clip.sourceIn : clip.sourceIn + deltaStart
    }
  }

  // right edge
  let newDuration = Math.max(MIN_CLIP_DURATION_SECONDS, pointerTime - clip.startTime)
  if (!isImage && Number.isFinite(sourceDurationSeconds)) {
    const maxDuration = Math.max(MIN_CLIP_DURATION_SECONDS, (sourceDurationSeconds as number) - clip.sourceIn)
    newDuration = Math.min(newDuration, maxDuration)
  }
  return {
    ...clip,
    duration: newDuration,
    sourceOut: isImage ? undefined : clip.sourceIn + newDuration
  }
}

/** Splits one clip at `atTime` into two adjacent clips (per the exact
 * left/right formulas the user's spec gives). Images: `sourceOut` stays
 * undefined on the left piece, right piece's `sourceIn` is 0 (same still
 * image, independently editable from here on). Video/audio:
 * `sourceOut`/`sourceIn` computed from the split offset so source timing is
 * preserved across the cut. `linkedClipId` is cleared on both pieces (the
 * original link no longer resolves to a single clip on each side -- see
 * `splitClipAndLinked` for keeping a linked pair split together). */
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
    sourceOut: isImage ? undefined : clip.sourceIn + offset,
    linkedClipId: undefined
  }
  const rightClip: TimelineClip = {
    ...clip,
    id: makeId(),
    startTime: atTime,
    duration: clip.duration - offset,
    sourceIn: isImage ? 0 : clip.sourceIn + offset,
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

  let clips = splitOneClip(sequence.clips, clipId, atTime, makeId)
  if (linkedTarget && canSplitClip(linkedTarget, atTime)) {
    clips = splitOneClip(clips, linkedTarget.id, atTime, makeId)
  }
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
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
  const clips = sequence.clips.filter((c) => !(idSet.has(c.id) && !c.locked))
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
 * timing/track/media/link identity. */
export type ClipPropertyPatch = Partial<Pick<TimelineClip, 'playbackRate' | 'opacity' | 'volume' | 'fadeIn' | 'fadeOut' | 'transform'>>

export function pickClipProperties(clip: TimelineClip): ClipPropertyPatch {
  return { playbackRate: clip.playbackRate, opacity: clip.opacity, volume: clip.volume, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, transform: clip.transform }
}

/** Applies a property patch (not timing) to every given unlocked clip --
 * backs both "Paste Attributes" and the Clip Properties panel's own field
 * edits. */
export function applyClipProperties(sequence: ProjectSequence, clipIds: string[], patch: ClipPropertyPatch): ProjectSequence {
  const idSet = new Set(clipIds)
  const clips = sequence.clips.map((c) => (idSet.has(c.id) && !c.locked ? { ...c, ...patch } : c))
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
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
export function replaceClipMedia(sequence: ProjectSequence, clipId: string, newMediaId: string, newSourceDurationSeconds: number): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  if (!target || target.locked) return sequence
  const clips = sequence.clips.map((c) => {
    if (c.id !== clipId) return c
    if (c.type === 'image') return { ...c, mediaId: newMediaId, sourceIn: 0, sourceOut: undefined }
    const duration = Math.min(c.duration, Math.max(MIN_CLIP_DURATION_SECONDS, newSourceDurationSeconds))
    return { ...c, mediaId: newMediaId, sourceIn: 0, sourceOut: duration, duration }
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
