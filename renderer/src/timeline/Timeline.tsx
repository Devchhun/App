import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useTimelineView, MIN_PPS, MAX_PPS } from './TimelineViewContext'
import { useTimelineShortcuts } from './useTimelineShortcuts'
import { useUiState } from '../nav/UiStateContext'
import { TimeRuler } from './TimeRuler'
import { playheadBadgeEdge } from './playheadBadgePosition'
import { computeTrackCentering } from './trackCentering'
import { TimelineToolbar } from './TimelineToolbar'
import { CaptionsTrack } from './CaptionsTrack'
import { GraphicsTrack } from './GraphicsTrack'
import { ClipTrack } from './ClipTrack'
import { TimelineTrackHeaders } from './TimelineTrackHeaders'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { visibleTracksForDisplay, trackDisplayHeight, isInViewport, type OccupiedRange } from './trackModel'
import { planSequentialDrop, planStackDrop, type PlannedPlacement } from './placementPlanning'
import { DropGhostPreview } from './DropGhostPreview'
import { normalizeRect, clipsInRect, applyBoxSelection, type ClipGeometry, type ScreenRect } from './boxSelection'
import { canSplitClip } from '../sequence/sequenceOps'
import { canFreezeFrame as canFreezeFrameCheck, useFreezeFrame } from './useFreezeFrame'
import { findGapAt } from './gapOps'
import { computeZoomAroundCursor } from './zoomMath'
import { DEFAULT_TIMELINE_VIEW_PREFS } from './timelineViewPrefs'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { MEDIA_DRAG_MIME_TYPE, getCurrentDragMediaIds, setCurrentDragMediaIds, type MediaDragPayload } from '../media/mediaDragPayload'
import { formatDuration } from '../media/format'
import type { MediaItem } from '@shared/media'
import type { TimelineClip, Scene } from '@shared/project'

// Mirrors styles.css's --timeline-ruler-height/--timeline-top-safe-zone/
// --timeline-content-start -- kept in sync by hand since CSS custom
// properties aren't readable from plain numeric JS geometry (trackTopById
// below, the drag-preview ghost boxes it feeds). If the CSS values ever
// change, these three need to change with them.
const RULER_HEIGHT_PX = 26
const TOP_SAFE_ZONE_PX = 60
const CONTENT_START_PX = RULER_HEIGHT_PX + TOP_SAFE_ZONE_PX

// CapCut-style main-track anchoring (not a fixed gap below the ruler): the
// main video track's own vertical center is targeted at
// TOP_SPACER_RATIO/(TOP_SPACER_RATIO+BOTTOM_SPACER_RATIO) of the usable
// track-area height -- ~46%, a bit above true center ("leaning slightly
// upward" per the reference design) -- via two spacer rows placed directly
// above/below the track group, each given an explicit computed height (see
// trackCentering.ts). As overlay tracks are added above main or
// audio/caption tracks below it, both spacers shrink to make room for them
// while keeping main itself anchored; once either spacer would need to go
// negative, it clamps to 0 and the track area grows past its budget --
// the ancestor scroll container takes over from there, same as always.
// Purely proportional, no fixed-pixel cap on either spacer -- see
// computeTrackCentering's own doc comment for why a cap here is itself a
// "not actually centered on a large monitor" bug, not a safeguard.
const TOP_SPACER_RATIO = 46
const BOTTOM_SPACER_RATIO = 54

// `viewportRange` starts `null` until the viewport-tracking effect below
// measures the scroll container -- see that effect's own doc comment for why
// it's a `useLayoutEffect` (to keep that gap from ever reaching a real
// paint). React 18 StrictMode still double-invokes that layout effect itself
// (mount -> simulated cleanup -> mount again) as part of its dev-only bug
// -detection, and on a long project (confirmed from ~2000s+) that extra
// churn right at mount was enough to occasionally still surface as
// TimeRuler's "Failed to execute 'removeChild'" -- reproducible only with a
// long/scrolled project, only in dev, exactly matching the failure this file
// already has one fix for above. Capping the "not measured yet" fallback
// here means the unmeasured render is never more than a couple of ticks
// away from the real one regardless of project length, instead of jumping
// from "every tick across the whole project" down to a handful.
const UNMEASURED_VIEWPORT_FALLBACK_SECONDS = 300

export function Timeline(): JSX.Element {
  const { items, selectedId, select: selectMediaForInspection, importPaths } = useMedia()
  const { transcripts } = useTranscript()
  const { currentTime, seekTo } = usePlayback()
  const { scenesByMedia, selectedSceneId, selectScene, retimeScene } = useScenes()
  const { setRightTab } = useUiState()
  const {
    sequence,
    selectedTimelineClipIds,
    selectClip,
    selectClips,
    clearClipSelection,
    moveClip,
    trimClip,
    insertPlannedClips,
    splitClipAt,
    rollEditClips,
    deleteSelected,
    duplicateSelected,
    splitSelected,
    copySelected,
    cutSelected,
    pasteAtTime,
    hasClipboardContent,
    linkSelected,
    unlinkSelected,
    relinkSelectedAudio,
    extractAudio,
    setSelectedEnabled,
    groupSelected,
    ungroupSelected,
    moveSelectedToTrack,
    addMarkerAtTime,
    removeGap,
    removeAllGapsOnTrack,
    reorderTrack,
    resetClipProperties,
    replaceClipMedia,
    addTrack
  } = useSequence()
  const {
    pixelsPerSecond,
    setPixelsPerSecond,
    timelineViewportWidth,
    setTimelineViewportWidth,
    trackHeaderWidth,
    setTrackHeaderWidth,
    linkageOn,
    tool,
    rangeSelection,
    setRangeSelection,
    skimmerOn,
    trackHeightMode
  } = useTimelineView()
  const { triggerFreezeFrame } = useFreezeFrame()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** 'scrub': dragging on the ruler seeks the playhead (existing behavior).
   * 'maybe-box': mousedown on empty track area -- not yet committed to a
   * box-select, since a plain click (no real movement) should still clear
   * selection + seek, matching the old click-anywhere-empty behavior.
   * 'box': movement crossed BOX_SELECT_THRESHOLD_PX -- now drawing a marquee.
   * 'pan': Hand tool -- dragging scrolls the Timeline instead of anything else.
   * 'range': Range tool -- dragging sets rangeSelection instead of anything else. */
  const draggingRef = useRef<'scrub' | 'maybe-box' | 'box' | 'pan' | 'range' | false>(false)
  const boxStartRef = useRef<{ x: number; y: number } | null>(null)
  const [boxRect, setBoxRect] = useState<ScreenRect | null>(null)
  const panStartRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null)
  /** Hover skimmer (spec section 7) -- a dimmer secondary line that follows
   * the mouse over Timeline content without moving the real playhead.
   * Updated by directly mutating this ref's DOM node on every mousemove
   * (not React state), same performance pattern as ClipTrack.tsx's live trim
   * tooltip -- a per-pixel-frequency visual doesn't need a re-render. */
  const skimmerRef = useRef<HTMLDivElement>(null)
  const snapGuideRef = useRef<HTMLDivElement>(null)
  const rangeStartTimeRef = useRef<number | null>(null)
  /** Batches box-select/range-select's setState calls to at most once per
   * animation frame -- mirrors ClipTrack.tsx's own rafIdRef/latestMoveRef
   * pattern for the identical class of problem (see its doc comment). Unlike
   * clip-drag, this path had NO throttling at all: every raw native
   * mousemove (browsers can dispatch far more of these than the display
   * refresh rate) called setBoxRect/setRangeSelection directly, forcing a
   * full Timeline re-render -- re-mapping every track's every clip -- on
   * each one. That's what made drag-to-select feel janky on any project with
   * more than a handful of clips. */
  const pointerMoveRafIdRef = useRef<number | null>(null)
  const latestPointerMoveRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const headerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  /** The track area's own visible height (`.timeline-scroll-2d`'s
   * clientHeight) -- purely local to this component, unlike
   * timelineViewportWidth, since nothing outside Timeline.tsx needs it. Used
   * to size the main-track centering layout below. */
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0)
  /** Which clip a ClipTrack instance is currently move-dragging, if any --
   * see ClipTrack.tsx's own doc comment on its draggingClipId prop for why
   * this lives here (lifted state) rather than an imperative DOM class. */
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null)
  const [dragPlacements, setDragPlacements] = useState<PlannedPlacement[] | null>(null)
  /** "Replace Media" (clip context menu) -- picking a file starts a real
   * import (proxy/thumbnail/duration all need generating same as any other
   * import), so the actual `replaceClipMedia` call has to wait until that
   * freshly-imported MediaItem shows up in `items` as 'ready'. Same
   * pending-ref-plus-effect-on-items pattern VoiceoverRecorder.tsx already
   * uses for its own "wait for the import pipeline" case. */
  const pendingReplaceRef = useRef<{ clipId: string; path: string } | null>(null)
  /** The visible horizontal time window, in project-absolute seconds -- for
   * long timelines (1-2 hour narration files) ClipTrack/GraphicsTrack use
   * this to skip rendering any clip/scene DOM node entirely outside it (see
   * their own `isInViewport` filter). `null` until the scroll container
   * exists/has been measured, meaning "render everything" -- a conservative
   * fallback, never a broken one. */
  const [viewportRange, setViewportRange] = useState<{ start: number; end: number } | null>(null)
  /** IDs of every clip/scene seen as of the last render -- lets the effect
   * below tell "something was just added" apart from any other reason the
   * arrays changed (move/trim/delete), without needing every different
   * insertion call site (Add to Timeline, drag-drop from Media, template
   * insert, Voiceover Recorder, paste, duplicate...) to separately remember
   * to scroll the view afterward. Covers clips (video/image/audio) AND
   * scenes (graphics/text) in one combined id set. */
  const knownClipIdsRef = useRef<Set<string> | null>(null)
  const knownSceneIdsRef = useRef<Set<string> | null>(null)

  // The currently-selected Media asset is used only to pick which media's
  // transcript/captions to show -- it must never gate whether the Timeline
  // (or the project sequence's own clips) render at all. Switching which
  // media is selected in the Media panel never touches `scenes` or `sequence`.
  const media = items.find((m) => m.id === selectedId)
  const transcript = media ? transcripts[media.id] : undefined
  const segments = transcript?.segments ?? []

  // Graphics scenes are already project-global on disk (Scene.startTime/endTime
  // are absolute seconds, not media-relative) -- flatten every media's bucket
  // instead of filtering by whichever media happens to be selected, so
  // switching Media assets never changes what's visible on any graphic track.
  const allScenes = useMemo(() => Object.values(scenesByMedia).flat(), [scenesByMedia])

  // GraphicsTrack's onRetime callback only knows the scene id -- SceneContext
  // still buckets scenes internally by mediaId (scenesByMedia), so retiming
  // needs it looked back up. Every id here always resolves (we're iterating
  // the very list this map was built from); `?? ''` is a type-safety
  // fallback only, never actually hit.
  const sceneMediaIdById = useMemo(() => Object.fromEntries(allScenes.map((s) => [s.id, s.mediaId] as const)), [allScenes])

  const mediaById = useMemo(() => Object.fromEntries(items.map((m) => [m.id, m] as const)), [items])

  // Every track row's own content, grouped by track id instead of N
  // hardcoded per-track filters -- this is what makes an arbitrary number of
  // tracks render without further changes here.
  const scenesByTrackId = useMemo(() => {
    const map: Record<string, Scene[]> = {}
    for (const scene of allScenes) (map[scene.track] ??= []).push(scene)
    return map
  }, [allScenes])
  const clipsByTrackId = useMemo(() => {
    const map: Record<string, TimelineClip[]> = {}
    for (const clip of sequence.clips) (map[clip.trackId] ??= []).push(clip)
    return map
  }, [sequence.clips])

  const trackHasContent = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const id of Object.keys(scenesByTrackId)) if (scenesByTrackId[id].length > 0) map[id] = true
    for (const id of Object.keys(clipsByTrackId)) if (clipsByTrackId[id].length > 0) map[id] = true
    return map
  }, [scenesByTrackId, clipsByTrackId])
  // Only tracks with real content (plus the main video track and the fixed
  // caption track, which stay visible even empty -- see
  // visibleTracksForDisplay's own doc comment) actually render as a row, so
  // an unused Overlay/Graphics/Music track -- or debris left behind by a past
  // bug -- doesn't clutter the Timeline. `sequence.tracks` itself is
  // untouched: hiding a track here never deletes it or its settings.
  const sortedTracks = useMemo(() => visibleTracksForDisplay(sequence.tracks, trackHasContent), [sequence.tracks, trackHasContent])

  const trackHeightById = useMemo(() => {
    const map: Record<string, number> = {}
    for (const t of sortedTracks) map[t.id] = trackDisplayHeight(t, trackHeightMode)
    return map
  }, [sortedTracks, trackHeightMode])

  // The main track's own vertical center (not the whole track group's) is
  // what's anchored at TOP_SPACER_RATIO's target -- see computeTrackCentering's
  // own doc comment for why that distinction matters (a linked audio track
  // below main, or any other below-track, would otherwise pull the group
  // center down and main away from the target).
  const usableTrackAreaHeight = Math.max(0, timelineViewportHeight - CONTENT_START_PX)
  const { topSpacerHeight, bottomSpacerHeight } = useMemo(
    () => computeTrackCentering(sortedTracks, trackHeightById, usableTrackAreaHeight, TOP_SPACER_RATIO, BOTTOM_SPACER_RATIO),
    [sortedTracks, trackHeightById, usableTrackAreaHeight]
  )

  // Cumulative row position/height per track, for the drag-drop ghost
  // preview to draw its dashed boxes against the right row (rows are plain
  // document flow within .timeline-tracks-area, not individually
  // positioned, so this is computed once per track-list/height change
  // rather than measured from the DOM). Starts after the top spacer's own
  // height, not directly at CONTENT_START_PX -- must stay in exact agreement
  // with the spacer's actual rendered height (set inline from the same
  // topSpacerHeight value below) or the ghost preview would draw against
  // the wrong row.
  const trackTopById = useMemo(() => {
    const map: Record<string, number> = {}
    let top = CONTENT_START_PX + topSpacerHeight
    for (const t of sortedTracks) {
      map[t.id] = top
      top += trackHeightById[t.id]
    }
    return map
  }, [sortedTracks, trackHeightById, topSpacerHeight])

  const occupiedRanges: OccupiedRange[] = useMemo(
    () => sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration })),
    [sequence.clips]
  )

  const dropTimeFromClientX = useCallback(
    (clientX: number): number => {
      const content = contentRef.current
      if (!content) return 0
      const rect = content.getBoundingClientRect()
      return Math.max(0, (clientX - rect.left) / pixelsPerSecond)
    },
    [pixelsPerSecond]
  )

  // Media-panel drag-and-drop: default drop places assets sequentially,
  // Alt-drop stacks them all at the same start time (see
  // placementPlanning.ts). `dataTransfer.getData` is only readable on the
  // actual `drop` event, not `dragover` (a standard HTML5 DnD restriction) --
  // the live ghost preview instead reads the dragged ids from
  // mediaDragPayload.ts's in-memory side-channel, set by MediaListItem's
  // onDragStart.
  const handleTimelineDragOver = useCallback(
    (e: React.DragEvent) => {
      const ids = getCurrentDragMediaIds()
      if (!ids || ids.length === 0) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const assets = ids.map((id) => mediaById[id]).filter((m): m is MediaItem => Boolean(m)).map(assetFromMediaItem)
      if (assets.length === 0) return
      const dropTime = dropTimeFromClientX(e.clientX)
      const plan = e.altKey ? planStackDrop : planSequentialDrop
      setDragPlacements(plan(assets, dropTime, sequence.tracks, occupiedRanges))
    },
    [mediaById, dropTimeFromClientX, sequence.tracks, occupiedRanges]
  )

  const handleTimelineDragLeave = useCallback((e: React.DragEvent) => {
    // Moving between child elements re-fires dragleave/dragover constantly --
    // only clear the preview once the pointer actually leaves the whole area.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragPlacements(null)
  }, [])

  const handleTimelineDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragPlacements(null)
      setCurrentDragMediaIds(null)
      const raw = e.dataTransfer.getData(MEDIA_DRAG_MIME_TYPE)
      if (!raw) return
      let payload: MediaDragPayload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      const assets = payload.mediaIds.map((id) => mediaById[id]).filter((m): m is MediaItem => Boolean(m)).map(assetFromMediaItem)
      if (assets.length === 0) return
      const dropTime = dropTimeFromClientX(e.clientX)
      const plan = e.altKey ? planStackDrop : planSequentialDrop
      insertPlannedClips(plan(assets, dropTime, sequence.tracks, occupiedRanges))
    },
    [mediaById, dropTimeFromClientX, sequence.tracks, occupiedRanges, insertPlannedClips]
  )

  // The Timeline's own duration is the project sequence's -- never derived
  // from whichever single media item happens to be selected. A project can
  // be pure graphics (scenes with no underlying clip at all), so this must
  // also cover whichever is longer, the clip sequence or the furthest scene,
  // or the ruler/scrub range would cap at 0 with no clips.
  const sceneMaxEnd = allScenes.reduce((max, s) => Math.max(max, s.endTime), 0)
  const effectiveDuration = Math.max(sequence.duration, sceneMaxEnd > 0 ? sceneMaxEnd + 5 : 0)

  useTimelineShortcuts(effectiveDuration)

  const activeSegmentId = useMemo(() => {
    const seg = segments.find((s) => currentTime >= s.startTime && currentTime < s.endTime)
    return seg?.id ?? null
  }, [segments, currentTime])

  const isEmpty = sequence.clips.length === 0 && allScenes.length === 0

  // The toolbar's "zoom to fit" now lives in the Preview panel and can't see
  // this scroll container directly, so publish its width into shared state.
  // useLayoutEffect, matching the viewport-range tracker below -- measuring
  // a DOM element's size and feeding it into render-relevant state is the
  // textbook case for running before paint rather than after it. Also
  // measures height here (not its own effect) purely to share one
  // ResizeObserver -- `clientHeight` is the track area's own vertical
  // budget for the main-track centering layout below (it already excludes
  // the horizontal scrollbar's own thickness, same as clientWidth already
  // excluding the vertical one). `isEmpty` has to be a dependency, same
  // reason as the wheel-listener and viewport-range effects below:
  // `.timeline-scroll-2d` (and therefore scrollRef.current) doesn't exist in
  // the empty-Timeline early return, so the very first time a project goes
  // from empty to having its first clip, this effect must re-run to find
  // the now-real element -- otherwise the empty-state mount already ran
  // this with nothing to observe, and neither viewport dimension is ever
  // measured for the rest of the session (the main-track centering layout
  // below would then always measure a 0px-tall track area).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const report = (): void => {
      setTimelineViewportWidth(el.clientWidth)
      setTimelineViewportHeight(el.clientHeight)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [setTimelineViewportWidth, isEmpty])

  // Selecting a scene whose time range the playhead isn't currently inside
  // seeks to it -- a scene only ever renders in Preview while the playhead is
  // inside its [startTime, endTime) range (see GraphicsOverlay.isSceneVisibleAt),
  // so this is what makes "select a clip" reliably show it instead of
  // silently doing nothing until the user separately scrubs to it.
  const handleSelectScene = useCallback(
    (sceneId: string) => {
      selectScene(sceneId)
      const scene = allScenes.find((s) => s.id === sceneId)
      if (scene && (currentTime < scene.startTime || currentTime >= scene.endTime)) {
        seekTo(scene.startTime)
      }
    },
    [selectScene, allScenes, currentTime, seekTo]
  )

  const handleDoubleClickClip = useCallback(
    (clip: TimelineClip) => {
      selectClip(clip.id)
      seekTo(clip.startTime)
    },
    [selectClip, seekTo]
  )

  const handleBladeSplit = useCallback(
    (clipId: string, atTime: number) => {
      splitClipAt(clipId, atTime, { linked: linkageOn })
    },
    [splitClipAt, linkageOn]
  )

  const handleReplaceMedia = useCallback(
    async (clipId: string) => {
      const paths = await window.api.media.pickFiles()
      const path = paths[0]
      if (!path) return
      pendingReplaceRef.current = { clipId, path }
      await importPaths([path])
    },
    [importPaths]
  )

  // Completes handleReplaceMedia once the freshly-imported file actually
  // finishes going through the import pipeline (proxy/thumbnail/duration).
  useEffect(() => {
    const pending = pendingReplaceRef.current
    if (!pending) return
    const match = items.find((item) => item.originalPath === pending.path)
    if (!match || (match.stage !== 'ready' && match.stage !== 'error')) return
    pendingReplaceRef.current = null
    if (match.stage === 'error') return
    replaceClipMedia(pending.clipId, match.id, match.metadata?.durationSeconds ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` should retrigger this; replaceClipMedia is a stable context callback.
  }, [items])

  /** Clip context menu (spec section 11) -- every item delegates to an
   * already-real command (clipboard, linkage, group, gap, track-reorder,
   * Freeze Frame via the shared useFreezeFrame hook -- see its own doc
   * comment for why it's safe to call from both here and the toolbar
   * button), nothing here is a placeholder. */
  const buildClipMenuItems = useCallback(
    (clip: TimelineClip): ContextMenuItem[] => {
      const media = mediaById[clip.mediaId]
      const sourceDurationSeconds = media?.metadata?.durationSeconds
      const canTrimToPlayhead = !clip.locked && currentTime > clip.startTime && currentTime < clip.startTime + clip.duration
      const otherCompatibleTracks = sequence.tracks.filter((t) => t.kind === (clip.type === 'audio' ? 'audio' : 'video') && t.id !== clip.trackId)

      return [
        // Cut/Duplicate/Delete always take a linked partner along -- a
        // linked pair is one logical clip for a structural operation like
        // these (remove/clone), not a movement-coupling choice, so none of
        // them are gated by the ambient Linkage toggle (see the Delete
        // item's own comment below for the full reasoning).
        { label: 'Cut', onClick: () => cutSelected() },
        { label: 'Copy', onClick: () => copySelected() },
        { label: 'Paste', onClick: () => pasteAtTime(currentTime), disabled: !hasClipboardContent() },
        { label: 'Duplicate', onClick: () => duplicateSelected() },
        { separator: true, label: '' },
        { label: 'Split at Playhead', onClick: () => splitSelected(currentTime, { linked: linkageOn }), disabled: !canSplitClip(clip, currentTime) },
        { label: 'Trim Start to Playhead', onClick: () => trimClip(clip.id, 'left', currentTime, sourceDurationSeconds, { linked: linkageOn }), disabled: !canTrimToPlayhead },
        { label: 'Trim End to Playhead', onClick: () => trimClip(clip.id, 'right', currentTime, sourceDurationSeconds, { linked: linkageOn }), disabled: !canTrimToPlayhead },
        {
          label: 'Ripple Trim End to Playhead',
          onClick: () => trimClip(clip.id, 'right', currentTime, sourceDurationSeconds, { rippleScope: 'current' }),
          disabled: !canTrimToPlayhead
        },
        { separator: true, label: '' },
        // Not gated by Linkage -- see the comment above the Cut item.
        // Leaving this on the ambient toggle previously orphaned a clip's
        // linked partner on the Timeline whenever Linkage happened to be
        // off, reported as "an item remains after deleting everything".
        // unlinkSelected (below) is the real, explicit way to detach a pair
        // before deleting only one side of it.
        { label: 'Delete', onClick: () => deleteSelected() },
        { label: 'Ripple Delete', onClick: () => deleteSelected({ rippleScope: 'current' }) },
        { separator: true, label: '' },
        { label: clip.enabled === false ? 'Enable' : 'Disable', onClick: () => setSelectedEnabled(clip.enabled === false) },
        {
          label: clip.linkedClipId ? 'Unlink' : 'Link Selected (2 clips)',
          onClick: clip.linkedClipId ? unlinkSelected : linkSelected,
          disabled: !clip.linkedClipId && selectedTimelineClipIds.length !== 2
        },
        { label: 'Relink Original Audio', onClick: relinkSelectedAudio, disabled: clip.type !== 'video' && clip.type !== 'audio' },
        {
          label: 'Extract to Audio',
          onClick: () => extractAudio(clip.id),
          disabled: clip.type !== 'video' || !!clip.linkedClipId || !media?.metadata?.hasAudio
        },
        { label: clip.groupId ? 'Ungroup' : 'Group Selected', onClick: clip.groupId ? ungroupSelected : groupSelected, disabled: !clip.groupId && selectedTimelineClipIds.length < 2 },
        { separator: true, label: '' },
        { label: 'Replace Media…', onClick: () => void handleReplaceMedia(clip.id), disabled: clip.locked },
        { label: 'Reset Attributes', onClick: () => resetClipProperties(selectedTimelineClipIds.includes(clip.id) ? selectedTimelineClipIds : [clip.id]) },
        { separator: true, label: '' },
        { label: 'Speed…', onClick: () => setRightTab('graphics') },
        { label: 'Freeze Frame', onClick: () => triggerFreezeFrame(clip), disabled: !canFreezeFrameCheck(clip, currentTime) },
        ...(otherCompatibleTracks.length > 0
          ? otherCompatibleTracks.map((t) => ({ label: `Move to ${t.name}`, onClick: () => moveSelectedToTrack(t.id) }))
          : []),
        { label: 'Bring Forward', onClick: () => reorderTrack(clip.trackId, 'up') },
        { label: 'Send Backward', onClick: () => reorderTrack(clip.trackId, 'down') },
        { separator: true, label: '' },
        { label: 'Reveal in Media Panel', onClick: () => selectMediaForInspection(clip.mediaId) },
        { label: 'Properties', onClick: () => setRightTab('graphics') }
      ]
    },
    [
      mediaById,
      currentTime,
      sequence.tracks,
      cutSelected,
      copySelected,
      pasteAtTime,
      hasClipboardContent,
      duplicateSelected,
      splitSelected,
      trimClip,
      deleteSelected,
      setSelectedEnabled,
      unlinkSelected,
      linkSelected,
      relinkSelectedAudio,
      extractAudio,
      ungroupSelected,
      groupSelected,
      selectedTimelineClipIds,
      moveSelectedToTrack,
      reorderTrack,
      selectMediaForInspection,
      setRightTab,
      linkageOn,
      triggerFreezeFrame,
      handleReplaceMedia,
      resetClipProperties
    ]
  )

  /** Ruler context menu -- markers, in/out points (reusing the Range tool's
   * own rangeSelection as the in/out concept, spec sections 4/12/18), and
   * Fit Timeline. */
  const zoomToFit = useCallback(() => {
    if (effectiveDuration > 0) {
      setPixelsPerSecond(Math.max(MIN_PPS, Math.min(MAX_PPS, timelineViewportWidth / effectiveDuration)))
    }
  }, [effectiveDuration, timelineViewportWidth, setPixelsPerSecond])

  /** Ctrl/Cmd+wheel zooms around the cursor (preserving the time under it,
   * never jumping the playhead); Shift+wheel scrolls horizontally; a plain
   * wheel is left alone for the browser's own native vertical scroll (spec
   * section 14). Alt+wheel is deliberately left to whatever the platform
   * already does with it rather than overridden.
   *
   * Attached as a real native listener (see the effect below) rather than
   * JSX `onWheel` -- React attaches its delegated wheel listener as passive,
   * so `e.preventDefault()` inside a JSX onWheel handler silently fails
   * (logs "Unable to preventDefault inside passive event listener
   * invocation" and lets the browser's own default wheel action run
   * alongside ours) for exactly the two branches below that call it. */
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const scrollEl = scrollRef.current
      if (!scrollEl) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = scrollEl.getBoundingClientRect()
        const cursorX = e.clientX - rect.left - trackHeaderWidth
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const rawNewPps = pixelsPerSecond * factor
        const newScrollLeft = computeZoomAroundCursor(scrollEl.scrollLeft, cursorX, pixelsPerSecond, rawNewPps)
        setPixelsPerSecond(rawNewPps)
        // The new content width only exists after this render commits --
        // apply the compensating scroll on the next frame.
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = newScrollLeft
        })
      } else if (e.shiftKey) {
        e.preventDefault()
        scrollEl.scrollLeft += e.deltaY
      }
    },
    [pixelsPerSecond, trackHeaderWidth, setPixelsPerSecond]
  )

  /** Same cursor-preserving math the wheel handler above uses, anchored on
   * the playhead's own position instead of the mouse -- there's no "last
   * mouse position" to anchor to when the toolbar's zoom-in/out buttons or
   * slider are clicked, and the playhead is the one position on screen a
   * user zooming via those controls is most likely trying to keep in view. */
  const zoomAroundPlayhead = useCallback(
    (newPps: number) => {
      const scrollEl = scrollRef.current
      const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, newPps))
      if (!scrollEl) {
        setPixelsPerSecond(clamped)
        return
      }
      const cursorX = currentTime * pixelsPerSecond - scrollEl.scrollLeft
      const newScrollLeft = computeZoomAroundCursor(scrollEl.scrollLeft, cursorX, pixelsPerSecond, clamped)
      setPixelsPerSecond(clamped)
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollLeft = newScrollLeft
      })
    },
    [currentTime, pixelsPerSecond, setPixelsPerSecond]
  )

  const buildRulerMenuItems = useCallback(
    (atTime: number): ContextMenuItem[] => [
      { label: 'Add Marker', onClick: () => addMarkerAtTime(atTime) },
      { separator: true, label: '' },
      { label: 'Set In Point', onClick: () => setRangeSelection({ start: atTime, end: Math.max(atTime, rangeSelection?.end ?? atTime) }) },
      { label: 'Set Out Point', onClick: () => setRangeSelection({ start: Math.min(atTime, rangeSelection?.start ?? atTime), end: atTime }) },
      { label: 'Clear In/Out', onClick: () => setRangeSelection(null), disabled: !rangeSelection },
      { separator: true, label: '' },
      { label: 'Fit Timeline', onClick: zoomToFit }
    ],
    [addMarkerAtTime, rangeSelection, setRangeSelection, zoomToFit]
  )

  /** Empty-Timeline-space context menu -- Paste, Add Track, Add Marker,
   * Select All After Playhead, and (when the right-click actually landed
   * inside a real gap on a real track) Delete Gap. */
  const buildEmptySpaceMenuItems = useCallback(
    (atTime: number, trackId: string | undefined): ContextMenuItem[] => {
      const gap = trackId ? findGapAt(sequence, trackId, atTime) : null
      return [
        { label: 'Paste', onClick: () => pasteAtTime(atTime), disabled: !hasClipboardContent() },
        { label: 'Add Video Track', onClick: () => addTrack('video') },
        { label: 'Add Audio Track', onClick: () => addTrack('audio') },
        { label: 'Add Marker', onClick: () => addMarkerAtTime(atTime) },
        {
          label: 'Select All After Playhead',
          onClick: () => selectClips(sequence.clips.filter((c) => c.startTime >= currentTime).map((c) => c.id))
        },
        ...(gap && trackId
          ? [
              { label: 'Remove Gap', onClick: () => removeGap(trackId, gap) },
              { label: 'Remove All Gaps on Track', onClick: () => removeAllGapsOnTrack(trackId) }
            ]
          : [])
      ]
    },
    [sequence, pasteAtTime, hasClipboardContent, addTrack, addMarkerAtTime, selectClips, currentTime, removeGap, removeAllGapsOnTrack]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const target = e.target as HTMLElement
      const content = contentRef.current
      if (!content) return
      const atTime = Math.max(0, (e.clientX - content.getBoundingClientRect().left) / pixelsPerSecond)

      const clipEl = target.closest<HTMLElement>('[data-clip-id]')
      if (clipEl) {
        const clip = sequence.clips.find((c) => c.id === clipEl.dataset.clipId)
        if (clip) {
          if (!selectedTimelineClipIds.includes(clip.id)) selectClip(clip.id)
          setContextMenu({ x: e.clientX, y: e.clientY, items: buildClipMenuItems(clip) })
          return
        }
      }

      if (target.closest('.timeline-ruler') || target.closest('.timeline-playhead-handle')) {
        setContextMenu({ x: e.clientX, y: e.clientY, items: buildRulerMenuItems(atTime) })
        return
      }

      const trackEl = target.closest<HTMLElement>('[data-track-id]')
      setContextMenu({ x: e.clientX, y: e.clientY, items: buildEmptySpaceMenuItems(atTime, trackEl?.dataset.trackId) })
    },
    [pixelsPerSecond, sequence.clips, selectedTimelineClipIds, selectClip, buildClipMenuItems, buildRulerMenuItems, buildEmptySpaceMenuItems]
  )

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const content = contentRef.current
      if (!content || effectiveDuration <= 0) return
      const rect = content.getBoundingClientRect()
      const x = clientX - rect.left
      const time = Math.min(effectiveDuration, Math.max(0, x / pixelsPerSecond))
      seekTo(time)
    },
    [effectiveDuration, pixelsPerSecond, seekTo]
  )

  const BOX_SELECT_THRESHOLD_PX = 4

  const contentLocalPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: clientX - rect.left, y: clientY - rect.top }
  }, [])

  // Every clip's screen-space (content-local) box, for box-select hit
  // testing -- reuses the same trackTopById/trackHeightById row geometry the
  // media-drop ghost preview already computes.
  const clipGeometries = useMemo<ClipGeometry[]>(
    () =>
      sequence.clips.map((c) => {
        const top = trackTopById[c.trackId] ?? 0
        return {
          id: c.id,
          trackId: c.trackId,
          left: c.startTime * pixelsPerSecond,
          right: (c.startTime + c.duration) * pixelsPerSecond,
          top,
          bottom: top + (trackHeightById[c.trackId] ?? 0)
        }
      }),
    [sequence.clips, pixelsPerSecond, trackTopById, trackHeightById]
  )

  const handlePointerDown = (e: React.MouseEvent): void => {
    // Reaches here for empty Timeline area / ruler clicks, AND (for Hand and
    // Range tools specifically) clicks that landed on a clip too -- see
    // ClipTrack.tsx/GraphicsTrack.tsx's own tool-aware bypass, which lets
    // those two tools' pointerdowns bubble all the way up here untouched.
    if (e.button === 1) {
      // Middle-mouse-drag pan (spec section 14) -- works regardless of the
      // active tool; ClipTrack.tsx/GraphicsTrack.tsx bypass it the same way
      // for a middle-click that lands directly on a clip.
      e.preventDefault()
      draggingRef.current = 'pan'
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, scrollLeft: scrollRef.current?.scrollLeft ?? 0, scrollTop: scrollRef.current?.scrollTop ?? 0 }
      return
    }
    if (e.button === 2) {
      // Right-click must never start a box-select/pan/scrub, and critically
      // must never fall into the 'maybe-box' -> stopDragging -> clearClipSelection
      // path below -- that path is what a plain left-click-on-empty-space
      // uses to deselect, and without this bailout a right-click on an
      // already-multi-selected clip would silently wipe the selection
      // (ClipTrack.tsx's own pointerdown bypass stops the clip's single-select
      // path, but the mousedown still bubbles up here) before the context
      // menu's own selection-preserving logic (handleContextMenu) ever runs.
      return
    }
    if (tool === 'hand') {
      draggingRef.current = 'pan'
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, scrollLeft: scrollRef.current?.scrollLeft ?? 0, scrollTop: scrollRef.current?.scrollTop ?? 0 }
      return
    }
    if (tool === 'range') {
      draggingRef.current = 'range'
      const t = dropTimeFromClientX(e.clientX)
      rangeStartTimeRef.current = t
      setRangeSelection({ start: t, end: t })
      return
    }
    // Ruler drags (and grabbing the playhead's own handle) scrub the playhead
    // (existing behavior); everywhere else starts a POTENTIAL box-select --
    // it isn't committed to one until the pointer actually moves (see
    // handlePointerMove), so a plain click still just clears selection +
    // seeks like before.
    if ((e.target as HTMLElement).closest('.timeline-ruler, .timeline-playhead-handle')) {
      draggingRef.current = 'scrub'
      seekFromClientX(e.clientX)
      return
    }
    draggingRef.current = 'maybe-box'
    boxStartRef.current = contentLocalPoint(e.clientX, e.clientY)
  }

  const handlePointerMove = (e: React.MouseEvent): void => {
    if (skimmerOn && skimmerRef.current) {
      const { x } = contentLocalPoint(e.clientX, e.clientY)
      skimmerRef.current.style.display = 'block'
      skimmerRef.current.style.left = `${x}px`
    }
    if (draggingRef.current === 'pan') {
      const start = panStartRef.current
      const scrollEl = scrollRef.current
      if (!start || !scrollEl) return
      scrollEl.scrollLeft = start.scrollLeft - (e.clientX - start.clientX)
      scrollEl.scrollTop = start.scrollTop - (e.clientY - start.clientY)
      return
    }
    if (draggingRef.current === 'scrub') {
      seekFromClientX(e.clientX)
      return
    }
    if (draggingRef.current === 'range' || draggingRef.current === 'maybe-box' || draggingRef.current === 'box') {
      latestPointerMoveRef.current = { clientX: e.clientX, clientY: e.clientY }
      if (pointerMoveRafIdRef.current === null) {
        pointerMoveRafIdRef.current = requestAnimationFrame(() => {
          pointerMoveRafIdRef.current = null
          const latest = latestPointerMoveRef.current
          if (latest) commitPointerMove(latest)
        })
      }
    }
  }

  const commitPointerMove = (e: { clientX: number; clientY: number }): void => {
    if (draggingRef.current === 'range') {
      const startTime = rangeStartTimeRef.current
      if (startTime === null) return
      const t = dropTimeFromClientX(e.clientX)
      setRangeSelection({ start: Math.min(startTime, t), end: Math.max(startTime, t) })
      return
    }
    if (draggingRef.current === 'maybe-box' || draggingRef.current === 'box') {
      const start = boxStartRef.current
      if (!start) return
      const { x, y } = contentLocalPoint(e.clientX, e.clientY)
      if (draggingRef.current === 'maybe-box') {
        if (Math.hypot(x - start.x, y - start.y) < BOX_SELECT_THRESHOLD_PX) return
        draggingRef.current = 'box'
      }
      setBoxRect(normalizeRect(start.x, start.y, x, y))
    }
  }

  const commitBoxSelection = (e: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void => {
    const start = boxStartRef.current
    if (!start) return
    const { x, y } = contentLocalPoint(e.clientX, e.clientY)
    const rect = normalizeRect(start.x, start.y, x, y)
    const hitIds = clipsInRect(rect, clipGeometries)
    selectClips(applyBoxSelection(selectedTimelineClipIds, hitIds, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }))
  }

  const stopDragging = (e: React.MouseEvent): void => {
    // A commit may still be scheduled for next frame -- flush it now so
    // `rangeSelection` (read directly, just below) and the box-select commit
    // are never a stale frame behind the pointer's actual last position.
    // Same reasoning as ClipTrack.tsx's own pointerup flush.
    if (pointerMoveRafIdRef.current !== null) {
      cancelAnimationFrame(pointerMoveRafIdRef.current)
      pointerMoveRafIdRef.current = null
      if (latestPointerMoveRef.current) commitPointerMove(latestPointerMoveRef.current)
    }
    if (draggingRef.current === 'pan') {
      draggingRef.current = false
      panStartRef.current = null
      return
    }
    if (draggingRef.current === 'range') {
      // A plain click (no real drag) clears the range rather than leaving a
      // zero-width one selected -- range selection must not accidentally
      // select clips or linger from an accidental click.
      if (rangeSelection && rangeSelection.start === rangeSelection.end) setRangeSelection(null)
      draggingRef.current = false
      rangeStartTimeRef.current = null
      return
    }
    if (draggingRef.current === 'box') {
      commitBoxSelection(e)
    } else if (draggingRef.current === 'maybe-box') {
      // Never actually moved -- a plain click, same as the old always-seek behavior.
      clearClipSelection()
      seekFromClientX(e.clientX)
    }
    draggingRef.current = false
    boxStartRef.current = null
    setBoxRect(null)
  }

  // Leaving the Timeline area mid-drag cancels rather than commits -- an
  // outside-the-content mouseup isn't visible to this element's own onMouseUp.
  const cancelDragging = (): void => {
    if (pointerMoveRafIdRef.current !== null) {
      cancelAnimationFrame(pointerMoveRafIdRef.current)
      pointerMoveRafIdRef.current = null
    }
    draggingRef.current = false
    boxStartRef.current = null
    setBoxRect(null)
    panStartRef.current = null
    if (skimmerRef.current) skimmerRef.current.style.display = 'none'
    if (snapGuideRef.current) snapGuideRef.current.style.display = 'none'
  }

  // Imperative, ref-mutation update for the shared snap-guide line -- passed
  // to every ClipTrack/GraphicsTrack row so a drag/trim on ANY track can show
  // the SAME one line (matches the skimmer's own "no React state, no
  // per-pixel re-render" pattern). `time === null` hides it.
  const updateSnapGuide = useCallback(
    (time: number | null) => {
      const el = snapGuideRef.current
      if (!el) return
      if (time === null) {
        el.style.display = 'none'
        return
      }
      el.style.display = 'block'
      el.style.left = `${time * pixelsPerSecond}px`
    },
    [pixelsPerSecond]
  )

  // Track-header column width resize -- lightweight local pointer-drag
  // rather than reusing Splitter.tsx (that component's absolute-overlay
  // positioning is tied to .workspace's own coordinate space; this handle
  // is a plain child of .timeline-header-column and just needs a delta).
  const handleHeaderResizePointerDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    headerResizeRef.current = { startX: e.clientX, startWidth: trackHeaderWidth }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic/invalid pointerId (automated testing) -- resize still
      // works via the handle's own pointermove/pointerup, just without
      // capture-outside-bounds.
    }
  }
  const handleHeaderResizePointerMove = (e: React.PointerEvent): void => {
    const drag = headerResizeRef.current
    if (!drag) return
    setTrackHeaderWidth(drag.startWidth + (e.clientX - drag.startX))
  }
  const handleHeaderResizePointerUp = (): void => {
    headerResizeRef.current = null
  }

  const contentWidth = Math.max(1, effectiveDuration * pixelsPerSecond)
  // The ruler alone (not the track rows -- see TimeRuler's own `duration`
  // width/tick-cap prop) visually fills at least the full visible viewport
  // width, continuing its ticks into the empty space past the actual
  // content instead of leaving it a dead blank strip once effectiveDuration
  // is narrower than the panel. Playhead seeking still can't reach that
  // extra space -- see PreviewPlayer.tsx's applyProjectTime, which clamps to
  // the real last clip/scene end, not this stretched value.
  //
  // `timelineViewportWidth` is `.timeline-scroll-2d`'s FULL clientWidth --
  // but the ruler itself lives inside `.timeline-content`, which only
  // starts after `.timeline-header-column` (the track-header strip on the
  // left, `trackHeaderWidth` wide). Sizing the ruler off the full viewport
  // width without subtracting that column made it exactly trackHeaderWidth
  // pixels too wide, pushing its rightmost tick(s) off the edge of the
  // window entirely -- not clipped by the Timeline's own scrollbar, past
  // the window itself, with no way to scroll to them.
  const rulerVisualDuration = Math.max(effectiveDuration, Math.max(0, timelineViewportWidth - trackHeaderWidth) / pixelsPerSecond)

  // Attached as a real native listener rather than JSX onWheel -- see
  // handleWheel's own doc comment for why. `isEmpty` has to be a dependency:
  // `.timeline-scroll-2d` (and therefore scrollRef.current) doesn't exist in
  // the DOM at all while the Timeline is in its empty state (see the early
  // return just below), so the effect must re-run once it flips to false and
  // the ref actually points at something -- a ref's `.current` changing on
  // its own is not something an effect can react to.
  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    scrollEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', handleWheel)
  }, [handleWheel, isEmpty])

  // Horizontal-culling viewport tracking (spec section 17: long narration
  // files must stay smooth) -- rAF-throttled since native scroll events fire
  // far more often than once per frame. A margin past both edges means a
  // clip just outside the visible area is already mounted (thumbnails
  // decoding, etc.) by the time a normal-speed scroll brings it into view,
  // rather than popping in only once fully visible.
  //
  // useLayoutEffect, not useEffect: on mount, `viewportRange` starts `null`,
  // which TimeRuler/the clip-visibility filters treat as "show everything"
  // (see their own `?? duration` fallbacks) -- for a long project (hundreds
  // to thousands of seconds), that's a real, separate commit rendering every
  // tick/clip across the FULL duration, immediately followed by this
  // effect's first `update()` call collapsing it down to just the visible
  // window. With `useEffect`, that collapse happens in its own post-paint
  // commit; in development, where React additionally double-invokes effects
  // (mount -> cleanup -> mount again) to surface exactly this kind of
  // ordering bug, the two back-to-back large-removal commits raced and
  // manifested as "Failed to execute 'removeChild': the node to be removed
  // is not a child of this node" inside TimeRuler, reproducible only on
  // long/scrolled projects and only in dev. `useLayoutEffect` runs
  // synchronously before the browser ever paints the "everything" state, so
  // the real viewport-clamped range is what actually commits -- no separate
  // large-removal commit for a second invocation to race against.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    let rafId: number | null = null
    const marginPx = 400
    const update = (): void => {
      rafId = null
      const start = Math.max(0, (scrollEl.scrollLeft - marginPx) / pixelsPerSecond)
      const end = (scrollEl.scrollLeft + scrollEl.clientWidth + marginPx) / pixelsPerSecond
      setViewportRange({ start, end })
    }
    const onScroll = (): void => {
      if (rafId === null) rafId = requestAnimationFrame(update)
    }
    update()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scrollEl)
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      observer.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [pixelsPerSecond, isEmpty])

  // Scrolls the Timeline the moment a new clip or scene first appears --
  // covers every insertion path (Add to Timeline, drag-drop from Media,
  // template insert, Voiceover Recorder, paste, duplicate) in one place,
  // rather than requiring each call site to separately remember to do this.
  // Skipped on the very first render after mount/project-load (the known-id
  // refs still null) so opening a project with existing content doesn't yank
  // the view to wherever its last item happens to be.
  //
  // This is purely a scroll position -- it never touches a clip/scene's real
  // startTime or the playhead. New items are always inserted at the exact
  // playhead time by their insertion call site (ImportPanel, Templates,
  // Voiceover Recorder); this effect only decides where that same point
  // lands within the visible viewport afterward.
  useEffect(() => {
    const currentClipIds = new Set(sequence.clips.map((c) => c.id))
    const previousClipIds = knownClipIdsRef.current
    knownClipIdsRef.current = currentClipIds
    const currentSceneIds = new Set(allScenes.map((s) => s.id))
    const previousSceneIds = knownSceneIdsRef.current
    knownSceneIdsRef.current = currentSceneIds
    if (!previousClipIds || !previousSceneIds) return
    const newClips = sequence.clips.filter((c) => !previousClipIds.has(c.id))
    const newScenes = allScenes.filter((s) => !previousSceneIds.has(s.id))
    if (newClips.length === 0 && newScenes.length === 0) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    // The EARLIEST new item's own start time -- which is also the playhead
    // time it was inserted at -- placed at ~42% from the left edge of the
    // viewport rather than dead-center, so more of the Timeline is visible
    // to the right (where the clip continues) than to the left.
    const earliestStart = Math.min(...newClips.map((c) => c.startTime), ...newScenes.map((s) => s.startTime))
    const contentWidthPx = scrollEl.clientWidth - trackHeaderWidth
    scrollEl.scrollLeft = Math.max(0, earliestStart * pixelsPerSecond - contentWidthPx * 0.42)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes pixelsPerSecond/trackHeaderWidth: this should only re-run when the clip/scene SET changes, not when the user separately zooms/resizes the header.
  }, [sequence.clips, allScenes])

  if (isEmpty) {
    return (
      <div className="timeline-root">
        <TimelineToolbar onZoom={zoomAroundPlayhead} />
        <div
          className="timeline-empty"
          onDragOver={(e) => {
            if (!getCurrentDragMediaIds()) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(e) => {
            e.preventDefault()
            setCurrentDragMediaIds(null)
            const raw = e.dataTransfer.getData(MEDIA_DRAG_MIME_TYPE)
            if (!raw) return
            try {
              const payload: MediaDragPayload = JSON.parse(raw)
              const assets = payload.mediaIds.map((id) => mediaById[id]).filter((m): m is MediaItem => Boolean(m)).map(assetFromMediaItem)
              if (assets.length > 0) insertPlannedClips(planSequentialDrop(assets, 0, sequence.tracks, []))
            } catch {
              // Malformed/foreign drag payload -- ignore.
            }
          }}
        >
          <div className="timeline-empty-card">
            <span className="timeline-empty-icon">▭</span>
            <span>Drag material here and start to create</span>
          </div>
        </div>
      </div>
    )
  }

  // The playhead's own time readout sits right next to the playhead line by
  // default (to its right) -- fine almost everywhere, since ruler ticks are
  // always >=70px apart (see rulerTicks.ts's minPxPerTick) and the playhead
  // is rarely exactly on one. It IS exactly on one very often at time 0
  // (every project's default/reset playhead position, and where "00:00"'s
  // own tick sits), where the badge would otherwise sit right on top of that
  // tick's label. Reading the scroll container's own current geometry
  // (rather than viewportRange, which pads 400px past each visible edge for
  // pre-mounting -- see the culling effect above) so "near an edge" means
  // the edge actually on screen right now: near the left edge, push the
  // badge further right, clear of a typical tick label's width; near the
  // right edge, flip it to the left entirely so it can never clip off-screen
  // or sit on top of whatever tick is there. The playhead LINE itself
  // (`.timeline-playhead`'s own `left`) is untouched either way.
  const playheadBadgeEdgeClass = ((): string => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return ''
    const edge = playheadBadgeEdge(currentTime * pixelsPerSecond, scrollEl.scrollLeft, scrollEl.scrollLeft + scrollEl.clientWidth)
    return edge ? ` timeline-playhead-badge-${edge}-edge` : ''
  })()

  return (
    <div className="timeline-root">
      <TimelineToolbar onZoom={zoomAroundPlayhead} />
      <div
        className="timeline-header-resize-handle"
        style={{ left: trackHeaderWidth }}
        onPointerDown={handleHeaderResizePointerDown}
        onPointerMove={handleHeaderResizePointerMove}
        onPointerUp={handleHeaderResizePointerUp}
        onPointerCancel={handleHeaderResizePointerUp}
        onDoubleClick={() => setTrackHeaderWidth(DEFAULT_TIMELINE_VIEW_PREFS.trackHeaderWidth)}
        title="Drag to resize track headers (double-click to reset)"
      />
      <div className="timeline-scroll-2d editor-scroll" ref={scrollRef}>
        <div className="timeline-header-column" style={{ width: trackHeaderWidth }}>
          <TimelineTrackHeaders tracks={sortedTracks} trackHasContent={trackHasContent} topSpacerHeight={topSpacerHeight} />
        </div>
        <div className="timeline-content-column">
          <div
            className="timeline-content"
            ref={contentRef}
            style={{ width: contentWidth }}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={stopDragging}
            onMouseLeave={cancelDragging}
            onDragOver={handleTimelineDragOver}
            onDragLeave={handleTimelineDragLeave}
            onDrop={handleTimelineDrop}
            onContextMenu={handleContextMenu}
          >
            <TimeRuler
              duration={rulerVisualDuration}
              pixelsPerSecond={pixelsPerSecond}
              markers={sequence.markers}
              viewStart={viewportRange?.start ?? 0}
              viewEnd={viewportRange?.end ?? Math.min(effectiveDuration, UNMEASURED_VIEWPORT_FALLBACK_SECONDS)}
            />
            {/* Permanent protected band between the ruler and the first track
                row -- see --timeline-top-safe-zone. Renders no content of its
                own; sticky (like the ruler above it) so it never scrolls away
                and no clip/track can ever occupy it. */}
            <div className="timeline-top-safe-zone" />

            {/* CapCut-style main-track centering (spec: "dynamic centering,
                not a fixed ruler gap") -- see TOP_SPACER_RATIO's own doc
                comment. minHeight is the track area's actual on-screen
                budget (viewport height minus ruler+safe-zone); the two
                spacers split whatever of that the track rows themselves
                don't use, so this collapses to ordinary stacked rows (and
                the ancestor scroll container takes over) once there are
                enough tracks to not fit. */}
            <div className="timeline-tracks-area" style={{ minHeight: usableTrackAreaHeight }}>
              <div className="timeline-tracks-spacer" style={{ height: topSpacerHeight }} />
              {sortedTracks.map((track) => {
              if (track.kind === 'graphic' || track.kind === 'text') {
                const trackScenes = scenesByTrackId[track.id] ?? []
                const visibleScenes = viewportRange
                  ? trackScenes.filter((s) => isInViewport(s.startTime, s.endTime - s.startTime, viewportRange.start, viewportRange.end))
                  : trackScenes
                return (
                  <GraphicsTrack
                    key={track.id}
                    track={track}
                    scenes={visibleScenes}
                    allClips={sequence.clips}
                    allScenes={allScenes}
                    markers={sequence.markers}
                    playheadTime={currentTime}
                    duration={effectiveDuration}
                    pixelsPerSecond={pixelsPerSecond}
                    selectedSceneId={selectedSceneId}
                    onSelect={handleSelectScene}
                    onRetime={(sceneId, start, end) => retimeScene(sceneMediaIdById[sceneId] ?? '', sceneId, start, end)}
                    onSnapGuide={updateSnapGuide}
                  />
                )
              }
              if (track.kind === 'caption') {
                return (
                  <CaptionsTrack
                    key={track.id}
                    segments={segments}
                    duration={effectiveDuration}
                    pixelsPerSecond={pixelsPerSecond}
                    activeSegmentId={activeSegmentId}
                    onSeek={seekTo}
                    height={trackDisplayHeight(track, trackHeightMode)}
                    hidden={track.hidden}
                  />
                )
              }
              // video / audio
              const clips = clipsByTrackId[track.id] ?? []
              const visibleClips = viewportRange ? clips.filter((c) => isInViewport(c.startTime, c.duration, viewportRange.start, viewportRange.end)) : clips
              return (
                <div key={track.id}>
                  <ClipTrack
                    track={track}
                    clips={visibleClips}
                    allClips={sequence.clips}
                    tracks={sequence.tracks}
                    markers={sequence.markers}
                    playheadTime={currentTime}
                    mediaById={mediaById}
                    duration={effectiveDuration}
                    pixelsPerSecond={pixelsPerSecond}
                    selectedClipIds={selectedTimelineClipIds}
                    onSelect={selectClip}
                    onDoubleClick={handleDoubleClickClip}
                    onMove={moveClip}
                    onTrim={trimClip}
                    onBladeSplit={handleBladeSplit}
                    onRollEdit={rollEditClips}
                    onSnapGuide={updateSnapGuide}
                    draggingClipId={draggingClipId}
                    onDraggingChange={setDraggingClipId}
                  />
                  {track.kind === 'audio' && clips.length === 0 && (
                    <span className="timeline-track-empty-label">No audio on this track</span>
                  )}
                </div>
              )
            })}
              <div className="timeline-tracks-spacer" style={{ height: bottomSpacerHeight }} />
            </div>

            <div className="timeline-playhead" style={{ left: currentTime * pixelsPerSecond }}>
              <div className="timeline-playhead-handle" title="Drag to scrub" />
              <span className={`timeline-playhead-badge${playheadBadgeEdgeClass}`}>{formatDuration(currentTime)}</span>
            </div>

            {skimmerOn && <div ref={skimmerRef} className="timeline-skimmer" style={{ display: 'none' }} />}
            <div ref={snapGuideRef} className="timeline-snap-guide" style={{ display: 'none' }} />

            {dragPlacements && (
              <DropGhostPreview placements={dragPlacements} pixelsPerSecond={pixelsPerSecond} trackTopById={trackTopById} trackHeightById={trackHeightById} />
            )}

            {boxRect && (
              <div
                className="timeline-box-select"
                style={{ left: boxRect.left, top: boxRect.top, width: boxRect.right - boxRect.left, height: boxRect.bottom - boxRect.top }}
              />
            )}

            {rangeSelection && (
              <div
                className="timeline-range-select"
                style={{ left: rangeSelection.start * pixelsPerSecond, width: Math.max(1, (rangeSelection.end - rangeSelection.start) * pixelsPerSecond) }}
              />
            )}
          </div>
        </div>
      </div>

      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
    </div>
  )
}

