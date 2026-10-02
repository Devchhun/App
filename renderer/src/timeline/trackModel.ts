// Pure logic for the dynamic Timeline track registry -- the one module both
// SequenceContext and SceneContext pull from, since routing/CRUD/ordering
// must be identical for clips and scenes (there's no other single owner of
// "all tracks" today; each context only owns its own content array). No
// React, fully unit-tested (see trackModel.test.ts), matching this
// codebase's established pure-module-first convention.
import type { TimelineTrack, TimelineTrackKind } from '@shared/timelineTracks'
import { MIN_TRACK_HEIGHT, DEFAULT_VIDEO_TRACK_HEIGHT, DEFAULT_AUDIO_TRACK_HEIGHT, DEFAULT_GRAPHIC_TRACK_HEIGHT } from '@shared/timelineTracks'
// Re-exported for backward compatibility -- every existing renderer import
// of `isTrackAudioMuted` still comes from here, but the implementation now
// lives in shared/ so shared/export.ts (main-process export compositor) can
// apply the exact same Mute/Solo semantics Preview does.
export { isTrackAudioMuted } from '@shared/timelineTracks'
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
 * of pushing time forward on an existing one.
 *
 * VO-prefixed tracks (VO1, VO2, ...) are excluded from the audio-kind
 * candidate list entirely -- they're reserved exclusively for Story
 * Narration Workspace accepted takes (see findOrCreateNarrationTrack, the
 * ONLY function allowed to route onto them). Without this exclusion, this
 * generic routing (used for every OTHER audio insertion -- Quick Record, a
 * regular video import's own auto-linked audio, Freeze Frame, etc.) could
 * land on an empty VO1 the same as any other free audio track, silently
 * mixing an unrelated video's own dialogue into the narration track.
 * DUB-prefixed tracks (DUB1, DUB2, ...) are excluded for the identical
 * reason -- reserved exclusively for AI Dubber generated clips (see
 * findOrCreateDubbingTrack). */
export function findOrCreateTrack(
  tracks: TimelineTrack[],
  occupiedRanges: OccupiedRange[],
  desiredStart: number,
  duration: number,
  kind: TimelineTrackKind
): RoutingResult {
  const candidates = tracksOfKind(tracks, kind)
    .filter((t) => !(kind === 'audio' && (/^VO\d+$/.test(t.id) || /^DUB\d+$/.test(t.id))))
    .sort((a, b) => a.order - b.order)
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

/** Where an accepted Story Narration take lands -- prefers the fixed VO1
 * track (the normal case: every segment's own non-overlapping time range
 * fits there in sequence), but a take that runs long (recording is never
 * forcibly cut off at the SRT boundary -- see NarrationContext.tsx's own
 * doc comment on that) can genuinely overlap an adjacent segment's own
 * already-accepted take. Same collision-avoidance as findOrCreateTrack,
 * scoped to VO-prefixed tracks specifically (VO1, VO2, ...) so overflow
 * narration takes land on a dedicated additional voice-over track rather
 * than a generic A-numbered one. */
export function findOrCreateNarrationTrack(tracks: TimelineTrack[], occupiedRanges: OccupiedRange[], desiredStart: number, duration: number): RoutingResult {
  const voTracks = tracks.filter((t) => t.kind === 'audio' && /^VO\d+$/.test(t.id)).sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
  for (const track of voTracks) {
    if (track.locked) continue
    const rangesOnTrack = occupiedRanges.filter((r) => r.trackId === track.id).map((r) => ({ startTime: r.startTime, endTime: r.endTime }))
    const resolvedStart = findNonOverlappingStart(rangesOnTrack, desiredStart, duration)
    if (resolvedStart === desiredStart) return { trackId: track.id }
  }
  const nextNum = voTracks.reduce((max, t) => Math.max(max, Number(t.id.slice(2))), 0) + 1
  const id = `VO${nextNum}`
  const newTrack: TimelineTrack = {
    id,
    kind: 'audio',
    name: `${id} · Voice Over`,
    order: trackOrderForNewTrack(tracks, 'audio'),
    height: defaultHeightForKind('audio'),
    hidden: false,
    locked: false,
    muted: false,
    removable: true
  }
  return { trackId: id, newTrack }
}

/** Where a generated AI Dubber clip lands -- identical collision-avoidance
 * to findOrCreateNarrationTrack, scoped to DUB-prefixed tracks (DUB1, DUB2,
 * ...) instead of VO-prefixed ones. Every dubbed line is normally placed at
 * its own subtitle's exact time range, so overlaps are rare, but two
 * adjacent subtitles with no gap between them (or a re-generated line that
 * now runs slightly longer) can still collide -- overflow lands on a
 * dedicated additional dubbing track rather than a generic A-numbered one. */
export function findOrCreateDubbingTrack(tracks: TimelineTrack[], occupiedRanges: OccupiedRange[], desiredStart: number, duration: number): RoutingResult {
  const dubTracks = tracks.filter((t) => t.kind === 'audio' && /^DUB\d+$/.test(t.id)).sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)))
  for (const track of dubTracks) {
    if (track.locked) continue
    const rangesOnTrack = occupiedRanges.filter((r) => r.trackId === track.id).map((r) => ({ startTime: r.startTime, endTime: r.endTime }))
    const resolvedStart = findNonOverlappingStart(rangesOnTrack, desiredStart, duration)
    if (resolvedStart === desiredStart) return { trackId: track.id }
  }
  const nextNum = dubTracks.reduce((max, t) => Math.max(max, Number(t.id.slice(3))), 0) + 1
  const id = `DUB${nextNum}`
  const newTrack: TimelineTrack = {
    id,
    kind: 'audio',
    name: `${id} · AI Dubbing`,
    order: trackOrderForNewTrack(tracks, 'audio'),
    height: defaultHeightForKind('audio'),
    hidden: false,
    locked: false,
    muted: false,
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

/** `trackHasContent` (Timeline.tsx) is built purely from `sequence.clips`/
 * scenes -- the caption track never carries either (CaptionsTrack renders
 * straight from `transcripts`, a wholly separate data source), so its own
 * entry could never become true any other way, leaving C1 permanently
 * invisible even once a video had a real AI transcript or an imported SRT
 * with actual segments -- despite visibleTracksForDisplay's own doc comment
 * promising it "stays visible once it has content." Called once with the
 * current media's own segment count; every caption-kind track (there is
 * normally exactly one, C1) is marked has-content together. */
export function withCaptionTrackContent(map: Record<string, boolean>, tracks: TimelineTrack[], hasCaptionSegments: boolean): Record<string, boolean> {
  if (!hasCaptionSegments) return map
  const next = { ...map }
  for (const t of tracks) if (t.kind === 'caption') next[t.id] = true
  return next
}

/** Which tracks the Timeline actually renders as a row -- an empty track (no
 * clips, no scenes) is only worth showing if it's structurally required: the
 * current main video track (isMain, so there's always an obvious place to
 * drop the primary footage even in an audio/graphics-only project, and so
 * the Timeline has an anchor to center around before anything else exists --
 * see Timeline.tsx's vertical-centering layout). Every other empty track --
 * the fixed caption track before anything's been transcribed/captioned, an
 * unused Overlay/Graphics/Music track, or debris a past bug left behind --
 * stays in the saved sequence (so a track the user just added but hasn't
 * used yet this session survives a save) but is hidden from view, matching a
 * CapCut-style compact Timeline instead of always showing every track a
 * project has ever accumulated. The empty space below whatever DOES render
 * remains the existing drop-to-auto-create-a-track target (see
 * ClipTrack.tsx's performMove), so hiding a track never removes the ability
 * to add one back. */
export function visibleTracksForDisplay(
  tracks: TimelineTrack[],
  trackHasContent: Record<string, boolean>,
  /** Track ids to show even when empty and not main -- used by the Story
   * Narration Workspace so VO1 is visible on the Timeline the moment the
   * workspace is prepared, before its first accepted take exists. */
  alwaysVisibleIds?: Set<string>
): TimelineTrack[] {
  return sortTracksForDisplay(tracks).filter((t) => trackHasContent[t.id] || t.isMain || alwaysVisibleIds?.has(t.id))
}

/** Display order for Timeline rows, with Main Track as a hard boundary:
 * every visual overlay (non-main video, graphic, text) stays above it;
 * only audio and caption/SRT rows may appear below it. Within the upper
 * visual group, higher paint order still renders first. */
export function sortTracksForDisplay(tracks: TimelineTrack[]): TimelineTrack[] {
  const rank = (track: TimelineTrack): number => {
    if (track.kind === 'video' && track.isMain) return 1
    if (track.kind === 'video' || track.kind === 'graphic' || track.kind === 'text') return 0
    if (track.kind === 'audio') return 2
    return 3
  }
  return [...tracks].sort((a, b) => {
    const kindDiff = rank(a) - rank(b)
    if (kindDiff !== 0) return kindDiff
    if (rank(a) === 0) return b.order - a.order // visual overlays: highest order first
    return a.order - b.order // audio (and caption, though there's only ever one)
  })
}

/** Track height multiplier per the Timeline-View-options height mode (spec
 * section 15) -- 'normal' is exactly today's unscaled behavior (the default
 * before this mode existed), so old projects/prefs render identically. */
const TRACK_HEIGHT_MODE_SCALE: Record<'compact' | 'normal' | 'tall', number> = { compact: 0.65, normal: 1, tall: 1.5 }

export function trackDisplayHeight(track: TimelineTrack, mode: 'compact' | 'normal' | 'tall' = 'normal'): number {
  // A track saved without a usable height (a damaged or hand-edited project)
  // gets its kind's default: a NaN height used to reach the waveform
  // canvas and take the whole Timeline down with a render error.
  const height = Number.isFinite(track.height) && track.height > 0 ? track.height : defaultHeightForKind(track.kind)
  const base = track.collapsed ? MIN_TRACK_HEIGHT : height
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
 * top"). A still image never does: a <video> cannot show a picture file,
 * so a logo on a track above the film left the film as an overlay and the
 * logo nowhere -- images are drawn as <img> overlays (keeping their
 * transparency) over whatever video plays. Generic over any clip shape
 * with trackId/startTime/duration so it doesn't need to import
 * TimelineClip and create a cycle. */
export function resolveActiveVideoClip<C extends { trackId: string; startTime: number; duration: number; type?: string }>(
  clips: C[],
  tracks: TimelineTrack[],
  time: number
): C | undefined {
  const videoTrackOrder = new Map(tracks.filter((t) => t.kind === 'video').map((t) => [t.id, t.order] as const))
  let best: C | undefined
  let bestOrder = -Infinity
  for (const clip of clips) {
    const order = videoTrackOrder.get(clip.trackId)
    if (order === undefined || clip.type === 'image') continue
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

/** The Story Narration Workspace's dedicated, always-created-first voice-
 * over track's fixed id -- accepted takes land here whenever it has room
 * (see sequenceOps.acceptNarrationTake), never on a generically-numbered
 * audio track. A take that overflows it (see findOrCreateNarrationTrack)
 * lands on VO2, VO3, ... instead -- use isNarrationTrackId, not a literal
 * `=== NARRATION_TRACK_ID` check, anywhere a clip/track needs to be
 * recognized as "a Story Narration take/track" regardless of which specific
 * VO-numbered one it ended up on. */
export const NARRATION_TRACK_ID = 'VO1'

/** True for VO1 and any overflow narration track created alongside it
 * (VO2, VO3, ...) -- see findOrCreateNarrationTrack. Every UI treatment
 * that's specific to an accepted Story Narration take (the violet "Take N"
 * badge/styling in ClipTrack.tsx, the live recording region) must check
 * this, not `=== NARRATION_TRACK_ID`, or a take that overflowed onto VO2+
 * silently renders as a plain, unstyled audio clip instead. */
export function isNarrationTrackId(trackId: string): boolean {
  return /^VO\d+$/.test(trackId)
}

/** Ensures VO1 exists -- idempotent, safe to call every time the workspace
 * is (re)prepared. `removable:false` mirrors the one fixed caption track's
 * own "always exists once created, not user-deletable" precedent (see
 * shared/timelineTracks.ts's C1): a Story Narration Workspace can't
 * function without somewhere to land accepted takes, so it isn't subject to
 * pruneEmptyTracks or the ordinary "..." menu's Delete Track action.
 * Labeled "VO1 · Voice Over" (not "Narration") to avoid confusion with A1,
 * which is already labeled "Narration" as the video's own linked/original
 * audio -- a completely different track. */
export function ensureNarrationTrack(tracks: TimelineTrack[]): TimelineTrack[] {
  if (tracks.some((t) => t.id === NARRATION_TRACK_ID)) return tracks
  const newTrack: TimelineTrack = {
    id: NARRATION_TRACK_ID,
    kind: 'audio',
    name: 'VO1 · Voice Over',
    order: trackOrderForNewTrack(tracks, 'audio'),
    height: defaultHeightForKind('audio'),
    hidden: false,
    locked: false,
    muted: false,
    removable: false
  }
  return [...tracks, newTrack]
}

/** AI Dubber's dedicated, always-created-first dubbing track's fixed id --
 * generated clips land here whenever it has room (see
 * sequenceOps.acceptDubbingClip), never on a generically-numbered audio
 * track. A clip that overflows it (see findOrCreateDubbingTrack) lands on
 * DUB2, DUB3, ... instead -- use isDubbingTrackId, not a literal
 * `=== DUBBING_TRACK_ID` check, anywhere a clip/track needs to be
 * recognized as "an AI Dubber clip/track" regardless of which specific
 * DUB-numbered one it ended up on. */
export const DUBBING_TRACK_ID = 'DUB1'

/** True for DUB1 and any overflow dubbing track created alongside it
 * (DUB2, DUB3, ...) -- see findOrCreateDubbingTrack. */
export function isDubbingTrackId(trackId: string): boolean {
  return /^DUB\d+$/.test(trackId)
}

/** Ensures DUB1 exists -- idempotent, safe to call every time the workspace
 * is (re)prepared. `removable:false` mirrors ensureNarrationTrack's own
 * precedent exactly: AI Dubber can't function without somewhere to land
 * generated clips, so it isn't subject to pruneEmptyTracks or the ordinary
 * "..." menu's Delete Track action. */
export function ensureDubbingTrack(tracks: TimelineTrack[]): TimelineTrack[] {
  if (tracks.some((t) => t.id === DUBBING_TRACK_ID)) return tracks
  const newTrack: TimelineTrack = {
    id: DUBBING_TRACK_ID,
    kind: 'audio',
    name: 'DUB1 · AI Dubbing',
    order: trackOrderForNewTrack(tracks, 'audio'),
    height: defaultHeightForKind('audio'),
    hidden: false,
    locked: false,
    muted: false,
    removable: false
  }
  return [...tracks, newTrack]
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

