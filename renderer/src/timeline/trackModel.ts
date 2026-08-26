// Pure logic for the dynamic Timeline track registry -- the one module both
// SequenceContext and SceneContext pull from, since routing/CRUD/ordering
// must be identical for clips and scenes (there's no other single owner of
// "all tracks" today; each context only owns its own content array). No
// React, fully unit-tested (see trackModel.test.ts), matching this
// codebase's established pure-module-first convention.
import type { TimelineTrack, TimelineTrackKind } from '@shared/timelineTracks'
import { MIN_TRACK_HEIGHT, DEFAULT_VIDEO_TRACK_HEIGHT, DEFAULT_AUDIO_TRACK_HEIGHT, DEFAULT_GRAPHIC_TRACK_HEIGHT } from '@shared/timelineTracks'
import { findNonOverlappingStart } from '../scenes/sceneTimelinePlacement'

const MAX_TRACK_HEIGHT = 160

/** Half-open-interval overlap test, same convention as
 * sceneTimelinePlacement.ts's findNonOverlappingStart (touching ranges, e.g.
 * [0,3) and [3,6), do not count as overlapping). */
export function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}

const KIND_ID_PREFIX: Record<TimelineTrackKind, string> = {
  video: 'V',
  graphic: 'G',
  text: 'T',
  audio: 'A',
  caption: 'C'
}

const KIND_NAME_LABEL: Record<TimelineTrackKind, string> = {
  video: 'Video',
  graphic: 'Graphic',
  text: 'Text',
  audio: 'Audio',
  caption: 'Caption'
}

function tracksOfKind(tracks: TimelineTrack[], kind: TimelineTrackKind): TimelineTrack[] {
  return tracks.filter((t) => t.kind === kind)
}

/** Next sequential id for a kind, gap-aware (V1,V3 existing -> next is V4,
 * not V2, so a deleted-then-recreated track never collides with a still-live
 * id that was never renumbered). */
export function nextTrackId(tracks: TimelineTrack[], kind: TimelineTrackKind): string {
  const prefix = KIND_ID_PREFIX[kind]
  let max = 0
  // Scans EVERY track whose id starts with this prefix, not just same-kind
  // ones -- the legacy graphic tracks from createDefaultTracks() keep the
  // ids 'V2'/'V3' for backward compatibility with existing saved projects
  // (see shared/timelineTracks.ts), which share the 'V' prefix with kind
  // 'video''s own numbering. Scoping this scan to same-kind only (as it
  // once did) let a freshly-created video track compute 'V2' too, silently
  // colliding with the existing graphic track and getting dropped by
  // ensureTrack's dedup check -- ALWAYS check id-prefix uniqueness across
  // the whole registry, regardless of kind.
  for (const t of tracks) {
    if (!t.id.startsWith(prefix)) continue
    const match = /^(\d+)$/.exec(t.id.slice(prefix.length))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}${max + 1}`
}

export function nextTrackName(tracks: TimelineTrack[], kind: TimelineTrackKind): string {
  return `${KIND_NAME_LABEL[kind]} ${tracksOfKind(tracks, kind).length + 1}`
}

function defaultHeightForKind(kind: TimelineTrackKind): number {
  if (kind === 'video') return DEFAULT_VIDEO_TRACK_HEIGHT
  if (kind === 'audio') return DEFAULT_AUDIO_TRACK_HEIGHT
  if (kind === 'graphic' || kind === 'text') return DEFAULT_GRAPHIC_TRACK_HEIGHT
  return DEFAULT_GRAPHIC_TRACK_HEIGHT
}

/** Video/graphic/text: paint order is "highest order on top," so a freshly
 * synthesized track goes ABOVE every existing same-kind track (visually on
 * top, newest wins) without disturbing existing tracks' own order values.
 * Audio/caption: order has no stacking meaning, just append. */
export function trackOrderForNewTrack(tracks: TimelineTrack[], kind: TimelineTrackKind): number {
  const sameKind = tracksOfKind(tracks, kind)
  if (sameKind.length === 0) return 0
  return Math.max(...sameKind.map((t) => t.order)) + 1
}

export interface RoutingResult {
  trackId: string
  newTrack?: TimelineTrack
}

export interface OccupiedRange {
  trackId: string
  startTime: number
  endTime: number
}

/** THE routing function -- backs clip insertion, scene/template insertion,
 * and multi-select stack-drop. Scans existing same-kind tracks (in `order`)
 * for one with no occupiedRanges entry overlapping the desired window; a
 * candidate only counts as "free" if findNonOverlappingStart would return
 * desiredStart unchanged (a genuine gap, not "would need a push"). If every
 * same-kind track is occupied at that time, synthesizes a new track instead
 * of pushing time forward on an existing one. */
export function findOrCreateTrack(
  tracks: TimelineTrack[],
  occupiedRanges: OccupiedRange[],
  desiredStart: number,
  duration: number,
  kind: TimelineTrackKind
): RoutingResult {
  const candidates = tracksOfKind(tracks, kind).sort((a, b) => a.order - b.order)
  for (const track of candidates) {
    if (track.locked) continue
    const rangesOnTrack = occupiedRanges.filter((r) => r.trackId === track.id).map((r) => ({ startTime: r.startTime, endTime: r.endTime }))
    const resolvedStart = findNonOverlappingStart(rangesOnTrack, desiredStart, duration)
    if (resolvedStart === desiredStart) return { trackId: track.id }
  }
  const id = nextTrackId(tracks, kind)
  const newTrack: TimelineTrack = {
    id,
    kind,
    name: nextTrackName(tracks, kind),
    order: trackOrderForNewTrack(tracks, kind),
    height: defaultHeightForKind(kind),
    hidden: false,
    locked: false,
    ...(kind === 'audio' ? { muted: false } : {}),
    removable: true
  }
  return { trackId: id, newTrack }
}

/** Horizontal-culling predicate (spec section 17: 1-2 hour narration files
 * must stay smooth) -- half-open-interval overlap test, same convention as
 * rangesOverlap, so a clip exactly touching the viewport edge (startTime ===
 * viewEnd) correctly counts as NOT visible rather than off-by-one flickering
 * in. Generic over just the two numbers every clip/scene shares (startTime +
 * duration, or startTime/endTime translated to duration by the caller) so
 * this works for both TimelineClip and Scene without importing either type. */
export function isInViewport(startTime: number, duration: number, viewStart: number, viewEnd: number): boolean {
  return startTime < viewEnd && startTime + duration > viewStart
}

/** Which tracks the Timeline actually renders as a row -- an empty track (no
 * clips, no scenes) is only worth showing if it's structurally required: the
 * current main video track (isMain, so there's always an obvious place to
 * drop the primary footage even in an audio/graphics-only project) or the
 * one fixed caption track (removable:false, a separate always-on feature
 * surface, not clutter). Every other empty track -- an unused
 * Overlay/Graphics/Music track, or debris a past bug left behind -- stays in
 * the saved sequence (so a track the user just added but hasn't used yet
 * this session survives a save) but is hidden from view, matching a
 * CapCut-style compact Timeline instead of always showing every track a
 * project has ever accumulated. The empty space below whatever DOES render
 * remains the existing drop-to-auto-create-a-track target (see
 * ClipTrack.tsx's performMove), so hiding a track never removes the ability
 * to add one back. */
export function visibleTracksForDisplay(tracks: TimelineTrack[], trackHasContent: Record<string, boolean>): TimelineTrack[] {
  return sortTracksForDisplay(tracks).filter((t) => trackHasContent[t.id] || t.isMain || !t.removable)
}

/** Display order for the Timeline's track rows: video/graphic/text render
 * with the highest-order (topmost-painting) track shown highest in the row
 * stack too, matching the existing V3-above-V2-above-V1 visual convention;
 * audio tracks list in ascending order; the caption track always sorts
 * last. */
export function sortTracksForDisplay(tracks: TimelineTrack[]): TimelineTrack[] {
  const rank: Record<TimelineTrackKind, number> = { video: 0, graphic: 0, text: 0, audio: 1, caption: 2 }
  return [...tracks].sort((a, b) => {
    const kindDiff = rank[a.kind] - rank[b.kind]
    if (kindDiff !== 0) return kindDiff
    if (rank[a.kind] === 0) return b.order - a.order // video/graphic/text: highest order first
    return a.order - b.order // audio (and caption, though there's only ever one)
  })
}

/** Track height multiplier per the Timeline-View-options height mode (spec
 * section 15) -- 'normal' is exactly today's unscaled behavior (the default
 * before this mode existed), so old projects/prefs render identically. */
const TRACK_HEIGHT_MODE_SCALE: Record<'compact' | 'normal' | 'tall', number> = { compact: 0.65, normal: 1, tall: 1.5 }

export function trackDisplayHeight(track: TimelineTrack, mode: 'compact' | 'normal' | 'tall' = 'normal'): number {
  const base = track.collapsed ? MIN_TRACK_HEIGHT : track.height
  return track.collapsed ? base : Math.max(MIN_TRACK_HEIGHT, Math.round(base * TRACK_HEIGHT_MODE_SCALE[mode]))
}

/** THE primary video track for CapCut-style magnetic/gapless editing (see
 * magnet.ts) -- an explicit flag lookup, not a derived "lowest-order video
 * track" (see TimelineTrack.isMain's doc comment for why). Undefined only if
 * every video track has somehow been deleted. */
export function getMainVideoTrackId(tracks: TimelineTrack[]): string | undefined {
  return tracks.find((t) => t.kind === 'video' && t.isMain)?.id
}

/** Picks the single clip that should drive the one <video> element at
 * `time`: among clips whose track is kind 'video', the one on the
 * highest-order track (matching "highest visual track renders/plays on
 * top"). Generic over any clip shape with trackId/startTime/duration so it
 * doesn't need to import TimelineClip and create a cycle. */
export function resolveActiveVideoClip<C extends { trackId: string; startTime: number; duration: number }>(
  clips: C[],
  tracks: TimelineTrack[],
  time: number
): C | undefined {
  const videoTrackOrder = new Map(tracks.filter((t) => t.kind === 'video').map((t) => [t.id, t.order] as const))
  let best: C | undefined
  let bestOrder = -Infinity
  for (const clip of clips) {
    const order = videoTrackOrder.get(clip.trackId)
    if (order === undefined) continue
    if (time < clip.startTime || time >= clip.startTime + clip.duration) continue
    if (order > bestOrder) {
      best = clip
      bestOrder = order
    }
  }
  return best
}

// ---- Track CRUD -- pure array transforms, id/order bookkeeping only ----

/** Adds an already-fully-formed track (e.g. the `newTrack` a prior
 * findOrCreateTrack call synthesized) if it isn't already present -- used by
 * insertion call sites so the exact track object that was decided on is what
 * gets added, rather than recomputing (and risking a different id if
 * something else changed the track list in between). Idempotent. */
export function ensureTrack(tracks: TimelineTrack[], track: TimelineTrack): TimelineTrack[] {
  if (tracks.some((t) => t.id === track.id)) return tracks
  return [...tracks, track]
}

/** `explicitId`, when given, is used verbatim instead of computing a fresh
 * `nextTrackId` -- lets a caller that already committed to an id (e.g. a
 * drag gesture that pre-computed the id it will reuse for every subsequent
 * pointermove, see ClipTrack.tsx's DragState.createdTrackId) create the
 * track under that exact id rather than risking a second, different id. */
export function addTrack(tracks: TimelineTrack[], kind: TimelineTrackKind, explicitId?: string): TimelineTrack[] {
  const newTrack: TimelineTrack = {
    id: explicitId ?? nextTrackId(tracks, kind),
    kind,
    name: nextTrackName(tracks, kind),
    order: trackOrderForNewTrack(tracks, kind),
    height: defaultHeightForKind(kind),
    hidden: false,
    locked: false,
    ...(kind === 'audio' ? { muted: false } : {}),
    removable: true
  }
  return [...tracks, newTrack]
}

/** Creates a new track of `kind` and positions it directly above or below
 * `referenceTrackId` in the display row order (used by the track header's
 * "Add Track Above/Below" menu items) -- composes addTrack (for id/name/kind
 * bookkeeping) with moveTrackToIndex (for exact placement) rather than
 * duplicating either's logic. If the reference track isn't found (or isn't
 * the same kind, so it isn't in the same display group), the new track is
 * simply left appended. */
export function addTrackAt(tracks: TimelineTrack[], kind: TimelineTrackKind, referenceTrackId: string, position: 'above' | 'below'): TimelineTrack[] {
  const withNew = addTrack(tracks, kind)
  const newTrack = withNew[withNew.length - 1]
  // moveTrackToIndex's target index is the new track's FINAL position within
  // the display group once it's been removed from wherever it started and
  // reinserted -- so the reference's index must be measured in the group
  // with the new track excluded (matching that internal remove-then-insert
  // mechanics), not the group as it stands with the new track already in it.
  const displayWithoutNew = sortTracksForDisplay(withNew.filter((t) => t.kind === kind && t.id !== newTrack.id))
  const referenceIndex = displayWithoutNew.findIndex((t) => t.id === referenceTrackId)
  if (referenceIndex === -1) return withNew
  const targetIndex = position === 'above' ? referenceIndex : referenceIndex + 1
  return moveTrackToIndex(withNew, newTrack.id, targetIndex)
}

export function duplicateTrack(tracks: TimelineTrack[], trackId: string): TimelineTrack[] {
  const source = tracks.find((t) => t.id === trackId)
  if (!source) return tracks
  const copy: TimelineTrack = {
    ...source,
    id: nextTrackId(tracks, source.kind),
    name: nextTrackName(tracks, source.kind),
    order: trackOrderForNewTrack(tracks, source.kind),
    // A duplicate is never THE main track -- there can only ever be one.
    isMain: false
  }
  return [...tracks, copy]
}

export function renameTrack(tracks: TimelineTrack[], trackId: string, name: string): TimelineTrack[] {
  const trimmed = name.trim()
  if (!trimmed) return tracks
  return tracks.map((t) => (t.id === trackId ? { ...t, name: trimmed } : t))
}

/** Rejects (no-op) removing a track with removable:false (the fixed caption
 * track). Non-empty-track confirmation is a UI-layer concern, enforced
 * before this is ever called. Removing the current main video track promotes
 * the next remaining video track (lowest order) to isMain, so magnetic
 * editing always has somewhere to apply as long as any video track exists. */
export function removeTrack(tracks: TimelineTrack[], trackId: string): TimelineTrack[] {
  const target = tracks.find((t) => t.id === trackId)
  if (!target || !target.removable) return tracks
  const remaining = tracks.filter((t) => t.id !== trackId)
  if (!target.isMain || target.kind !== 'video') return remaining
  const nextMain = remaining.filter((t) => t.kind === 'video').sort((a, b) => a.order - b.order)[0]
  if (!nextMain) return remaining
  return remaining.map((t) => (t.id === nextMain.id ? { ...t, isMain: true } : t))
}

/** Moves a track to `targetIndex` within its own kind-and-rank group only
 * (matching sortTracksForDisplay's grouping) -- reassigns every affected
 * track's `order` to its new position, video/graphic/text descending (so
 * index 0 = topmost = highest order) and audio ascending. Backs both
 * pointer-drag reorder and the Move Up/Down buttons (which just compute
 * targetIndex = currentIndex -1/+1 and call this). */
export function moveTrackToIndex(tracks: TimelineTrack[], trackId: string, targetIndex: number): TimelineTrack[] {
  const target = tracks.find((t) => t.id === trackId)
  if (!target) return tracks
  const groupIds = new Set(sortTracksForDisplay(tracks.filter((t) => t.kind === target.kind)).map((t) => t.id))
  const displayOrder = sortTracksForDisplay(tracks).filter((t) => groupIds.has(t.id))
  const currentIndex = displayOrder.findIndex((t) => t.id === trackId)
  if (currentIndex === -1) return tracks
  const clampedTarget = Math.max(0, Math.min(displayOrder.length - 1, targetIndex))
  if (clampedTarget === currentIndex) return tracks

  const reordered = [...displayOrder]
  const [moved] = reordered.splice(currentIndex, 1)
  reordered.splice(clampedTarget, 0, moved)

  // Reassign `order` values descending (video/graphic/text: index 0 = highest
  // order = topmost) or ascending (audio) over the same numeric range the
  // group already occupied, so other kinds' order values are untouched.
  const ascending = target.kind === 'audio' || target.kind === 'caption'
  const orderValues = displayOrder.map((t) => t.order).sort((a, b) => (ascending ? a - b : b - a))
  const newOrderById = new Map(reordered.map((t, i) => [t.id, orderValues[i]] as const))

  return tracks.map((t) => (newOrderById.has(t.id) ? { ...t, order: newOrderById.get(t.id)! } : t))
}

export function reorderTrack(tracks: TimelineTrack[], trackId: string, direction: 'up' | 'down'): TimelineTrack[] {
  const target = tracks.find((t) => t.id === trackId)
  if (!target) return tracks
  const groupIds = new Set(sortTracksForDisplay(tracks.filter((t) => t.kind === target.kind)).map((t) => t.id))
  const displayOrder = sortTracksForDisplay(tracks).filter((t) => groupIds.has(t.id))
  const currentIndex = displayOrder.findIndex((t) => t.id === trackId)
  return moveTrackToIndex(tracks, trackId, currentIndex + (direction === 'up' ? -1 : 1))
}

export function setTrackHeight(tracks: TimelineTrack[], trackId: string, height: number): TimelineTrack[] {
  const clamped = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, height))
  return tracks.map((t) => (t.id === trackId ? { ...t, height: clamped } : t))
}

export type TrackFlag = 'hidden' | 'locked' | 'muted' | 'solo' | 'collapsed'

export function toggleTrackFlag(tracks: TimelineTrack[], trackId: string, flag: TrackFlag): TimelineTrack[] {
  return tracks.map((t) => (t.id === trackId ? { ...t, [flag]: !t[flag] } : t))
}

export function collapseAll(tracks: TimelineTrack[], collapsed: boolean): TimelineTrack[] {
  return tracks.map((t) => ({ ...t, collapsed }))
}

/** Resolves whether a track's audio should be silenced, given the whole
 * sequence's tracks -- standard DAW-style Mute/Solo semantics: once ANY
 * track is soloed, every non-soloed track is silenced regardless of its own
 * `muted` flag, while the soloed track(s) themselves stay audible even if
 * also explicitly muted (soloing always wins for that same track);
 * otherwise (nothing soloed) a track is silenced only by its own `muted`
 * flag. Used by PreviewPlayer.tsx to actually apply the track header's
 * Mute/Solo controls to playback (previously typed and toggleable but never
 * read anywhere, so they had no real effect). */
export function isTrackAudioMuted(tracks: TimelineTrack[], trackId: string): boolean {
  const track = tracks.find((t) => t.id === trackId)
  if (!track) return false
  const anySoloed = tracks.some((t) => t.solo)
  if (anySoloed) return !track.solo
  return !!track.muted
}
