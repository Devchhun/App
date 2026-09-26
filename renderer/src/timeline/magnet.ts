// CapCut-style Main Track magnetic/gapless editing (spec section 2) --
// applies ONLY to the single track flagged TimelineTrack.isMain (see
// trackModel.ts's getMainVideoTrackId), never to overlay/graphic/text/audio
// tracks, which always allow free positioning and gaps regardless of this
// toggle. Reordering is modeled as "remove from the gapless list, find the
// nearest boundary to reinsert at, repack everything gaplessly from the
// track's own start" rather than arbitrary-time placement -- a gapless track
// is fundamentally an ORDERED LIST, not a set of clips at arbitrary times.
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { buildInsertedClips, type InsertableAsset } from '../sequence/sequenceOps'
import { getMainVideoTrackId } from './trackModel'

type IdFactory = () => string
const defaultMakeId: IdFactory = () => crypto.randomUUID()

function mainTrackClipsSorted(clips: TimelineClip[], trackId: string): TimelineClip[] {
  return clips.filter((c) => c.trackId === trackId).sort((a, b) => a.startTime - b.startTime)
}

/** The nearest clip boundary (a clip start or end) on `trackId` to `atTime`
 * -- "dropping new media inserts at the nearest boundary" (spec). An empty
 * track has exactly one boundary, 0. */
export function nearestInsertionBoundary(clips: TimelineClip[], trackId: string, atTime: number): number {
  const onTrack = mainTrackClipsSorted(clips, trackId)
  if (onTrack.length === 0) return 0
  const boundaries = [onTrack[0].startTime, ...onTrack.map((c) => c.startTime + c.duration)]
  let nearest = boundaries[0]
  let nearestDist = Math.abs(atTime - nearest)
  for (const b of boundaries) {
    const d = Math.abs(atTime - b)
    if (d < nearestDist) {
      nearest = b
      nearestDist = d
    }
  }
  return nearest
}

/** Moves `clipId` into/reorders it within the Main Track's gapless order:
 * finds where among the other clips `newStartTime` falls (nearest to which
 * clip's midpoint), reinserts it there, and repacks the whole track from 0.
 * This also accepts a video/image arriving from another video track. Main
 * Track is an always-magnetic ordered list, not an arbitrary-time lane.
 * Cascades linked partners (e.g. this clip's own audio on A1) by the
 * same delta when `linked` is true (default), exactly like the ordinary
 * moveClip does -- gated by the Linkage toggle at the call site. A no-op if
 * the clip is locked, missing, or the only clip on its track (nothing to
 * reorder against). */
export function moveClipMagnetic(sequence: ProjectSequence, clipId: string, newStartTime: number, linked = true): ProjectSequence {
  const target = sequence.clips.find((c) => c.id === clipId)
  const mainTrackId = getMainVideoTrackId(sequence.tracks)
  if (!target || target.locked || !mainTrackId || (target.type !== 'video' && target.type !== 'image')) return sequence

  const onTrack = mainTrackClipsSorted(sequence.clips, mainTrackId)
  const others = onTrack.filter((c) => c.id !== clipId)

  let insertIndex = others.length
  for (let i = 0; i < others.length; i++) {
    const midpoint = others[i].startTime + others[i].duration / 2
    if (newStartTime < midpoint) {
      insertIndex = i
      break
    }
  }

  const reordered = [...others]
  reordered.splice(insertIndex, 0, target)

  const newStartById = new Map<string, number>()
  // Main Track owns the project origin: even a lone clip that was dragged
  // into empty future space returns to 00:00 on release.
  let cursor = 0
  for (const c of reordered) {
    newStartById.set(c.id, cursor)
    cursor += c.duration
  }

  let clips = sequence.clips.map((c) => {
    const newStart = newStartById.get(c.id)
    if (newStart === undefined) return c
    const trackId = c.id === clipId ? mainTrackId : c.trackId
    if (newStart === c.startTime && trackId === c.trackId) return c
    return { ...c, trackId, startTime: newStart }
  })

  // Cascade every reordered clip's linked partner (e.g. its A1 audio) by the
  // same delta it just moved by -- mirrors sequenceOps.moveClip's existing
  // linked-clip behavior. Skipped entirely when Linkage is off.
  for (const c of linked ? reordered : []) {
    if (!c.linkedClipId) continue
    const newStart = newStartById.get(c.id)!
    const delta = newStart - c.startTime
    if (delta === 0) continue
    clips = clips.map((x) => (x.id === c.linkedClipId && !x.locked ? { ...x, startTime: Math.max(0, x.startTime + delta) } : x))
  }

  if (clips.every((clip, index) => clip === sequence.clips[index])) return sequence
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}

/** Inserts a new asset onto the main video track at the nearest boundary to
 * `atTime`, pushing every clip at/after that boundary right by the new
 * clip's duration so the track stays gapless (spec: "dropping new video/
 * image inserts it at the nearest boundary... clip order changes without
 * overlaps"). Returns `sequence` unchanged if there is no main track (the
 * caller should fall back to ordinary/routed insertion in that case). */
export function insertClipMagnetic(
  sequence: ProjectSequence,
  asset: InsertableAsset,
  atTime: number,
  makeId: IdFactory = defaultMakeId,
  overrides?: Partial<Pick<TimelineClip, 'muted'>>
): ProjectSequence {
  const mainTrackId = getMainVideoTrackId(sequence.tracks)
  if (!mainTrackId || (asset.type !== 'video' && asset.type !== 'image')) return sequence

  const boundary = nearestInsertionBoundary(sequence.clips, mainTrackId, atTime)
  const inserted = buildInsertedClips(asset, boundary, mainTrackId, makeId, overrides)
  const mainClip = inserted.find((c) => c.trackId === mainTrackId)
  if (!mainClip) return sequence

  const existing = mainTrackClipsSorted(sequence.clips, mainTrackId)
  const insertIndex = existing.findIndex((clip) => clip.startTime >= boundary)
  const ordered = [...existing]
  ordered.splice(insertIndex < 0 ? ordered.length : insertIndex, 0, mainClip)

  const newStartById = new Map<string, number>()
  let cursor = 0
  for (const clip of ordered) {
    newStartById.set(clip.id, cursor)
    cursor += clip.duration
  }

  let clips = sequence.clips.map((clip) => {
    const startTime = newStartById.get(clip.id)
    return startTime === undefined || startTime === clip.startTime ? clip : { ...clip, startTime }
  })
  // Existing main clips may have detached/linked audio. Keep each partner
  // aligned when packing the visual master track around the insertion.
  for (const clip of existing) {
    if (!clip.linkedClipId) continue
    const delta = newStartById.get(clip.id)! - clip.startTime
    if (delta === 0) continue
    clips = clips.map((candidate) => candidate.id === clip.linkedClipId && !candidate.locked
      ? { ...candidate, startTime: Math.max(0, candidate.startTime + delta) }
      : candidate)
  }
  const packedInserted = inserted.map((clip) => clip.id === mainClip.id ? { ...clip, startTime: newStartById.get(clip.id)! } : clip)
  clips = [...clips, ...packedInserted]
  return { ...sequence, clips, duration: computeSequenceDuration(clips) }
}
