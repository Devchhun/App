import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlaybackTime, usePlaybackControls, type SeekOptions } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useTimelineView, MIN_PPS, MAX_PPS } from './TimelineViewContext'
import { useTimelineShortcuts } from './useTimelineShortcuts'
import { useUiState } from '../nav/UiStateContext'
import { TimeRuler } from './TimeRuler'
import { playheadBadgeEdge } from './playheadBadgePosition'
import { computeTrackCentering, computeSafeZoneHeight } from './trackCentering'
import { TimelineToolbar } from './TimelineToolbar'
import { CaptionsTrack } from './CaptionsTrack'
import { GraphicsTrack } from './GraphicsTrack'
import { ClipTrack } from './ClipTrack'
import { TimelineTrackHeaders } from './TimelineTrackHeaders'
import { useConfirm } from '../ui/ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { visibleTracksForDisplay, trackDisplayHeight, isInViewport, withCaptionTrackContent, isNarrationTrackId, NARRATION_TRACK_ID, type OccupiedRange } from './trackModel'
import { useNarration } from '../narration/NarrationContext'
import { useAiDubber } from '../dubbing/AiDubberContext'
import { planSequentialDrop, planStackDrop, type DropAsset, type PlannedPlacement } from './placementPlanning'
import { DropGhostPreview } from './DropGhostPreview'
import { normalizeRect, clipsInRect, applyBoxSelection, clampBoxSelectionX, type ClipGeometry, type ScreenRect } from './boxSelection'
import { canSplitClip } from '../sequence/sequenceOps'
import { updateClipSelection, type ClickModifiers } from '../sequence/sequenceSelection'
import { canFreezeFrame as canFreezeFrameCheck, useFreezeFrame } from './useFreezeFrame'
import { findGapAt } from './gapOps'
import { computeZoomAroundCursor } from './zoomMath'
import { DEFAULT_TIMELINE_VIEW_PREFS } from './timelineViewPrefs'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { MEDIA_DRAG_MIME_TYPE, getCurrentDragMediaIds, setCurrentDragMediaIds, type MediaDragPayload } from '../media/mediaDragPayload'
import { formatDuration } from '../media/format'
import { computeTimelineDisplayDuration } from './timelineDuration'
import { nextPlaybackScrollLeft } from './playbackFollow'
import { nearestInsertionBoundary } from './magnet'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey, type DubbingEngine } from '../dubbing/voxcpmSettings'
import { ENGINE_LABEL } from '../dubbing/engineVoices'
import { SubtitleQuickEditor } from './SubtitleQuickEditor'
import { REMOVE_BACKGROUND_EVENT } from '../media/removeBackgroundEvent'
import type { MediaItem } from '@shared/media'
import type { TimelineClip, Scene } from '@shared/project'
import type { TimelineTrackKind } from '@shared/timelineTracks'
import type { KeyframeableProperty } from '@shared/keyframes'

// Mirrors styles.css's --timeline-ruler-height/--timeline-top-safe-zone --
// kept in sync by hand since CSS custom properties aren't readable from
// plain numeric JS geometry (trackTopById below, the drag-preview ghost
// boxes it feeds). If the CSS values ever change, these need to change with
// them. TOP_SAFE_ZONE_PX is the band's MAXIMUM: the live value (safeZonePx
// below) shrinks it on a squeezed panel, and drives the CSS variable back
// the other way so both sides stay in agreement.
const RULER_HEIGHT_PX = 26
const TOP_SAFE_ZONE_PX = 34

// CapCut-style main-track anchoring (not a fixed gap below the ruler): the
// main video track's own vertical center is targeted at
// TOP_SPACER_RATIO/(TOP_SPACER_RATIO+BOTTOM_SPACER_RATIO) of the usable
// track-area height -- 46%, a hair above true center so a lone clip reads
// as centered. (It was briefly 36% to leave more room below the last
// Audio/SRT row; that put a single clip visibly high, and the user asked
// for it back. The room below is guaranteed by MIN_BOTTOM_SPACER_PX
// instead, which only matters once rows fill the panel.) Two spacer rows placed directly
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
const MIN_BOTTOM_SPACER_PX = 28

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

/** Pointer this close to the visible content's left/right edge (or past
 * it) while dragging scrolls the Timeline sideways -- see
 * startEdgeAutoScroll. */
const EDGE_AUTOSCROLL_ZONE_PX = 48
/** px per frame: gentle just inside the zone, up to a brisk page-crawl
 * when the pointer is well outside the Timeline. */
function edgeAutoScrollSpeed(distanceIntoZonePx: number): number {
  return Math.min(28, 3 + distanceIntoZonePx / 5)
}

export function Timeline(): JSX.Element {
  const { items, selectedId, select: selectMediaForInspection, importPaths } = useMedia()
  const { transcripts, moveSegment, moveSegments, removeSegments } = useTranscript()
  const { currentTime } = usePlaybackTime()
  const { seekTo, isPlaying, setPlaying } = usePlaybackControls()
  const { scenesByMedia, selectedSceneId, selectedSceneIds, selectScene, selectScenes, retimeScene, deleteScenes } = useScenes()
  const { setRightTab } = useUiState()
  const narration = useNarration()
  const aiDubber = useAiDubber()
  const {
    sequence,
    selectedTimelineClipIds,
    selectClip,
    selectClips,
    clearClipSelection,
    moveClip,
    moveClipSet,
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
    addTrack,
    removeKeyframe,
    mirrorAudioUnderClips
  } = useSequence()
  const confirm = useConfirm()
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
    trackHeightMode,
    timelinePanelHeightPx
  } = useTimelineView()
  const { triggerFreezeFrame } = useFreezeFrame()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  /** The subtitle being typed / voiced in place (see SubtitleQuickEditor). */
  const [subtitleEditor, setSubtitleEditor] = useState<{ segmentId: string; isNew: boolean } | null>(null)
  const closeSubtitleEditor = useCallback(() => setSubtitleEditor(null), [])
  const [selectedCaptionSegmentIds, setSelectedCaptionSegmentIds] = useState<string[]>([])

  const scrollRef = useRef<HTMLDivElement>(null)
  /** `.timeline-scroll-2d`'s scrollLeft as of its last scroll/resize (the
   * viewport tracker below records it) -- read in render instead of the
   * element's own scrollLeft, which forces a synchronous layout on every
   * render of the Timeline. */
  const scrollLeftRef = useRef(0)
  const timelineRootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** 'scrub': dragging on the ruler seeks the playhead (existing behavior).
   * 'maybe-box': mousedown on empty track area -- not yet committed to a
   * box-select, since a plain click (no real movement) should still clear
   * selection + seek, matching the old click-anywhere-empty behavior.
   * 'box': movement crossed BOX_SELECT_THRESHOLD_PX -- now drawing a marquee.
   * 'pan': Hand tool -- dragging scrolls the Timeline instead of anything else.
   * 'range': Range tool -- dragging sets rangeSelection instead of anything else. */
  const draggingRef = useRef<'scrub' | 'maybe-box' | 'box' | 'pan' | 'range' | false>(false)
  /** A scrub that began during playback: playback is paused for the drag
   * and resumes on release. Left playing, the playback clock (which never
   * steps backwards and follows the lagging <video>) and the pointer both
   * moved the playhead every frame -- it jumped back and forth between them. */
  const resumeAfterScrubRef = useRef(false)
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
  /** The instrumental track waiting on its import round-trip, plus the video
   * clip it belongs under -- same pending-ref-then-items-effect pattern as
   * pendingReplaceRef above. */
  const pendingVocalRemovalRef = useRef<{ clipIds: string[]; path: string } | null>(null)
  /** Remove Background on a picture: the running job (its pill), or the
   * last error to show. The cut-out comes back through the same import +
   * pendingReplaceRef round-trip Replace Media uses. */
  const [backgroundJob, setBackgroundJob] = useState<{ clipId: string; jobId: string; stage: string; percent: number } | null>(null)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [removingVocalsClipId, setRemovingVocalsClipId] = useState<string | null>(null)
  /** The running Remove Vocal job, for its Cancel button. */
  const vocalJobIdRef = useRef<string | null>(null)
  /** Live progress of the running Remove Vocal job (see the onProgress
   * subscription below) -- null when nothing is running. */
  const [vocalProgress, setVocalProgress] = useState<{ percent: number; stage: string } | null>(null)

  useEffect(() => {
    return window.api.vocalRemoval.onProgress((p) => setVocalProgress({ percent: p.percent, stage: p.stage }))
  }, [])
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
  // Keep the empty fallback referentially stable. A fresh `[]` on every
  // render invalidated trackHasContent -> sortedTracks -> the viewport
  // layout effect below. That effect updates viewportRange, so the first
  // clip added to an otherwise-empty Timeline entered an infinite render
  // loop (React error #185) even though no captions existed at all.
  const segments = useMemo(() => transcript?.segments ?? [], [transcript?.segments])
  // Only the subtitles in view are drawn, like clips and scenes.
  const visibleCaptionSegments = useMemo(
    () => (viewportRange ? segments.filter((s) => isInViewport(s.startTime, s.endTime - s.startTime, viewportRange.start, viewportRange.end)) : segments),
    [segments, viewportRange]
  )

  useEffect(() => {
    const existing = new Set(segments.map((segment) => segment.id))
    setSelectedCaptionSegmentIds((current) => {
      const next = current.filter((id) => existing.has(id))
      return next.length === current.length ? current : next
    })
  }, [transcript?.segments])

  const selectCaptionSegment = useCallback((segmentId: string, modifiers: ClickModifiers = {}) => {
    // A normal click is an exclusive Timeline selection, regardless of
    // whether the previously-selected item was a clip, graphic, or caption.
    // Ctrl/Shift intentionally keep the other item types selected so the
    // user can build a mixed selection (box-select follows the same rule).
    if (!modifiers.ctrl && !modifiers.shift) {
      clearClipSelection()
      selectScenes([])
    }
    setSelectedCaptionSegmentIds((current) => updateClipSelection(current, segmentId, segments.map((segment) => segment.id), modifiers))
  }, [segments, clearClipSelection, selectScenes])

  const removeSelectedCaptions = useCallback(() => {
    if (!selectedId || selectedCaptionSegmentIds.length === 0) return
    if (aiDubber.state.videoMediaId === selectedId) aiDubber.removeSubtitles(selectedCaptionSegmentIds)
    else removeSegments(selectedId, selectedCaptionSegmentIds)
    setSelectedCaptionSegmentIds([])
  }, [selectedId, selectedCaptionSegmentIds, aiDubber, removeSegments])

  /** Deletes the selected subtitles -- asking first unless it is one line
   * on its own. Subtitles are not on the Undo stack, and they get selected
   * in bulk without anyone meaning to: a box drawn to delete dub clips picks
   * up every subtitle under it, Ctrl+A selects all of them. Either followed
   * by Delete silently wiped 181 lines of an episode. The Delete key and the
   * toolbar's delete both come through here. */
  const removeSelectedCaptionsAsking = useCallback(() => {
    const captionCount = selectedCaptionSegmentIds.length
    if (captionCount === 0) return
    const otherItems = selectedTimelineClipIds.length > 0 || selectedSceneIds.length > 0
    if (captionCount === 1 && !otherItems) {
      removeSelectedCaptions()
      return
    }
    void confirm({
      title: otherItems ? `Also delete ${captionCount} subtitle${captionCount === 1 ? '' : 's'}?` : `Delete ${captionCount} subtitles?`,
      message: [
        otherItems
          ? `The selection also covered ${captionCount} subtitle line${captionCount === 1 ? '' : 's'}. The clips are deleted; the subtitles only if you say so.`
          : `${captionCount} subtitle lines will be removed.`,
        'Subtitles cannot be brought back with Undo.'
      ],
      confirmLabel: 'Delete subtitles',
      danger: true
    }).then((ok) => {
      if (ok) removeSelectedCaptions()
      else setSelectedCaptionSegmentIds([])
    })
  }, [selectedCaptionSegmentIds.length, selectedTimelineClipIds.length, selectedSceneIds.length, removeSelectedCaptions, confirm])

  const deleteAllSelectedTimelineItems = useCallback(() => {
    // Captions first: the question must see the clips still selected.
    removeSelectedCaptionsAsking()
    if (selectedTimelineClipIds.length > 0) deleteSelected()
    if (selectedSceneIds.length > 0) deleteScenes(selectedSceneIds)
  }, [removeSelectedCaptionsAsking, selectedTimelineClipIds.length, deleteSelected, selectedSceneIds, deleteScenes])

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

  // Viewport-culled clips per track, computed once per render pass instead
  // of inline inside the tracks .map() below -- that inline version built a
  // fresh array for EVERY track on EVERY render (independent of playback),
  // which alone defeated React.memo(ClipTrack) even before the playhead-prop
  // fix. Object.is-stable per track as long as clipsByTrackId/viewportRange
  // haven't actually changed.
  //
  // ...except `viewportRange` is a fresh object on every scroll frame (see
  // its own rAF'd update effect below), and `.filter()` a fresh array even
  // when it selects exactly the same clips -- so scrolling, or dragging a
  // clip anywhere near the edge, handed every track a brand-new `clips` prop
  // 60x a second and re-rendered the entire Timeline each time. Culling
  // membership only actually changes when a clip crosses the window's edge,
  // so the previous array is reused whenever the result is element-wise
  // identical, and memo(ClipTrack) holds for every untouched track.
  const previousVisibleClipsRef = useRef<Record<string, TimelineClip[]>>({})
  const visibleClipsByTrackId = useMemo(() => {
    if (!viewportRange) return clipsByTrackId
    const previous = previousVisibleClipsRef.current
    const map: Record<string, TimelineClip[]> = {}
    for (const [trackId, clips] of Object.entries(clipsByTrackId)) {
      const culled = clips.filter((c) => isInViewport(c.startTime, c.duration, viewportRange.start, viewportRange.end))
      const before = previous[trackId]
      map[trackId] = before && before.length === culled.length && before.every((c, i) => c === culled[i]) ? before : culled
    }
    previousVisibleClipsRef.current = map
    return map
  }, [clipsByTrackId, viewportRange])

  const trackHasContent = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const id of Object.keys(scenesByTrackId)) if (scenesByTrackId[id].length > 0) map[id] = true
    for (const id of Object.keys(clipsByTrackId)) if (clipsByTrackId[id].length > 0) map[id] = true
    return withCaptionTrackContent(map, sequence.tracks, segments.length > 0)
  }, [scenesByTrackId, clipsByTrackId, segments, sequence.tracks])
  // Only tracks with real content (plus the main video track and the fixed
  // caption track, which stay visible even empty -- see
  // visibleTracksForDisplay's own doc comment) actually render as a row, so
  // an unused Overlay/Graphics/Music track -- or debris left behind by a past
  // bug -- doesn't clutter the Timeline. `sequence.tracks` itself is
  // untouched: hiding a track here never deletes it or its settings.
  // Story Narration Workspace: VO1 stays visible on the Timeline the moment
  // the workspace is prepared, even before its first accepted take, so the
  // user can see the recording target row -- not gated behind having
  // content the way an ordinary empty Overlay/Music track is.
  // AI Dubber: the subtitle row shows as soon as there is a video, before
  // its first subtitle -- right-click on it is where one is added.
  const hasVideoClip = useMemo(() => sequence.clips.some((clip) => clip.type === 'video'), [sequence.clips])
  const showEmptyCaptionRow = aiDubber.active && hasVideoClip
  const alwaysVisibleTrackIds = useMemo(() => {
    const ids = new Set<string>()
    if (narration.active) ids.add(NARRATION_TRACK_ID)
    if (showEmptyCaptionRow) for (const track of sequence.tracks) if (track.kind === 'caption') ids.add(track.id)
    return ids.size > 0 ? ids : undefined
  }, [narration.active, showEmptyCaptionRow, sequence.tracks])
  // Story Narration Workspace: "Take N" labels for VO1's accepted clips, and
  // the live red in-progress recording region shown on VO1 while actively
  // recording/reviewing the current segment (before it's been accepted, so
  // there's no real clip to represent it yet).
  const narrationTakeLabels = useMemo(() => {
    const map: Record<string, number> = {}
    for (const segState of Object.values(narration.state.segments)) {
      if (segState.acceptedClipId) map[segState.acceptedClipId] = segState.takes.length
    }
    return map
  }, [narration.state.segments])
  const narrationLiveRecordingRegion = useMemo(() => {
    if (!narration.active || !narration.currentSegment) return null
    if (narration.phase !== 'recording' && narration.phase !== 'reviewing') return null
    const { startTime, endTime } = narration.currentSegment
    return {
      startTime,
      endTime: narration.phase === 'recording' ? Math.max(startTime, currentTime) : endTime,
      analyserRef: narration.mic.analyserRef,
      isRecording: narration.phase === 'recording'
    }
  }, [narration.active, narration.currentSegment, narration.phase, currentTime, narration.mic.analyserRef])
  const sortedTracks = useMemo(
    () => visibleTracksForDisplay(sequence.tracks, trackHasContent, alwaysVisibleTrackIds),
    [sequence.tracks, trackHasContent, alwaysVisibleTrackIds]
  )

  // Projects created before Add Text received a dedicated `text` track may
  // still store lower-thirds on a graphic row. Present those rows with the
  // correct text glyph without destructively rewriting saved project data.
  const trackIconKindById = useMemo(() => {
    const result: Record<string, TimelineTrackKind> = {}
    for (const track of sortedTracks) {
      const scenes = scenesByTrackId[track.id] ?? []
      result[track.id] = track.kind === 'graphic' && scenes.length > 0 && scenes.every((scene) => scene.templateId === 'lower-third')
        ? 'text'
        : track.kind
    }
    return result
  }, [sortedTracks, scenesByTrackId])

  const trackHeightById = useMemo(() => {
    const map: Record<string, number> = {}
    for (const t of sortedTracks) map[t.id] = trackDisplayHeight(t, trackHeightMode)
    return map
  }, [sortedTracks, trackHeightMode])

  // The protected empty band under the ruler only keeps its full height for
  // as long as the panel can afford it -- see computeSafeZoneHeight's own
  // doc comment for why a squeezed panel has to give it up to keep the
  // track rows themselves on screen.
  const totalTrackRowsHeight = useMemo(
    () => sortedTracks.reduce((sum, t) => sum + (trackHeightById[t.id] ?? 0), 0),
    [sortedTracks, trackHeightById]
  )
  const safeZonePx = computeSafeZoneHeight(timelineViewportHeight, RULER_HEIGHT_PX, totalTrackRowsHeight, TOP_SAFE_ZONE_PX)
  const contentStartPx = RULER_HEIGHT_PX + safeZonePx

  // The main track's own vertical center (not the whole track group's) is
  // what's anchored at TOP_SPACER_RATIO's target -- see computeTrackCentering's
  // own doc comment for why that distinction matters (a linked audio track
  // below main, or any other below-track, would otherwise pull the group
  // center down and main away from the target).
  //
  // Budgeted over EVERYTHING below the ruler, protected band included, then
  // the band's own height is deducted from the top spacer it shares that gap
  // with. Centering used to be budgeted over only the space BELOW the band,
  // which quietly made the band pure extra dead space stacked on top of an
  // already-centered layout: the gap above the clips came out a full
  // safe-zone taller than the one below them (measured on a real panel: 65px
  // above vs 14px below), which is exactly the "it never centers the item"
  // this kept being reported as. Counting the band as part of the top gap
  // instead balances it, with the deliberate 40/60 upward lean.
  const trackAreaBudget = Math.max(0, timelineViewportHeight - RULER_HEIGHT_PX)
  const { topSpacerHeight: topGapTotal, bottomSpacerHeight } = useMemo(
    () =>
      computeTrackCentering(
        sortedTracks,
        trackHeightById,
        trackAreaBudget,
        TOP_SPACER_RATIO,
        BOTTOM_SPACER_RATIO,
        MIN_BOTTOM_SPACER_PX
      ),
    [sortedTracks, trackHeightById, trackAreaBudget]
  )
  const topSpacerHeight = Math.max(0, topGapTotal - safeZonePx)
  const usableTrackAreaHeight = Math.max(0, timelineViewportHeight - contentStartPx)

  // Cumulative row position/height per track, for the drag-drop ghost
  // preview to draw its dashed boxes against the right row (rows are plain
  // document flow within .timeline-tracks-area, not individually
  // positioned, so this is computed once per track-list/height change
  // rather than measured from the DOM). Starts after the top spacer's own
  // height, not directly at contentStartPx -- must stay in exact agreement
  // with the spacer's actual rendered height (set inline from the same
  // topSpacerHeight value below) or the ghost preview would draw against
  // the wrong row. Uses the LIVE contentStartPx (not the fixed constant) so
  // it still lines up once a squeezed panel has collapsed the safe zone.
  const trackTopById = useMemo(() => {
    const map: Record<string, number> = {}
    let top = contentStartPx + topSpacerHeight
    for (const t of sortedTracks) {
      map[t.id] = top
      top += trackHeightById[t.id]
    }
    return map
  }, [sortedTracks, trackHeightById, topSpacerHeight, contentStartPx])

  const occupiedRanges: OccupiedRange[] = useMemo(
    () => sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration })),
    [sequence.clips]
  )

  /** Dropping directly on the Main Track is an ordered-list insertion, not
   * collision-aware free placement. It therefore targets the nearest cut
   * boundary and never creates an overlay track just because V1 is already
   * occupied at the pointer time. */
  const planMediaDrop = useCallback((assets: DropAsset[], dropTime: number, stack: boolean, targetTrackId?: string): PlannedPlacement[] => {
    const mainTrack = sequence.tracks.find((track) => track.kind === 'video' && track.isMain)
    if (mainTrack && targetTrackId === mainTrack.id && assets.every((asset) => asset.type === 'video' || asset.type === 'image')) {
      const boundary = nearestInsertionBoundary(sequence.clips, mainTrack.id, dropTime)
      return planSequentialDrop(assets, boundary, [mainTrack], [])
    }
    return (stack ? planStackDrop : planSequentialDrop)(assets, dropTime, sequence.tracks, occupiedRanges)
  }, [sequence.tracks, sequence.clips, occupiedRanges])

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
      const targetTrackId = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-track-id]')?.dataset.trackId : undefined
      setDragPlacements(planMediaDrop(assets, dropTime, e.altKey, targetTrackId))
    },
    [mediaById, dropTimeFromClientX, planMediaDrop]
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
      const targetTrackId = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-track-id]')?.dataset.trackId : undefined
      insertPlannedClips(planMediaDrop(assets, dropTime, e.altKey, targetTrackId))
    },
    [mediaById, dropTimeFromClientX, planMediaDrop, insertPlannedClips]
  )

  // The Timeline's own duration is the project sequence's -- never derived
  // from whichever single media item happens to be selected. A project can
  // be pure graphics (scenes with no underlying clip at all), so this must
  // also cover whichever is longer, the clip sequence or the furthest scene,
  // or the ruler/scrub range would cap at 0 with no clips.
  const effectiveDuration = computeTimelineDisplayDuration(
    sequence.duration,
    allScenes.map((scene) => scene.endTime),
    segments.map((segment) => segment.endTime)
  )
  const playbackEndTime = Math.max(
    sequence.clips.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0),
    ...allScenes.map((scene) => scene.endTime),
    0
  )
  // Unlike effectiveDuration (which includes visual padding), this is the
  // exact right edge of the final selectable Timeline item. Box selection
  // is clamped here so it cannot grow through an empty future.
  const timelineItemEndTime = Math.max(
    playbackEndTime,
    ...segments.map((segment) => segment.endTime),
    0
  )

  const captionShortcuts = useMemo(() => ({
    selectedIds: selectedCaptionSegmentIds,
    allIds: segments.map((segment) => segment.id),
    select: setSelectedCaptionSegmentIds,
    removeSelected: removeSelectedCaptionsAsking
  }), [selectedCaptionSegmentIds, segments, removeSelectedCaptionsAsking])
  useTimelineShortcuts(effectiveDuration, captionShortcuts, playbackEndTime)

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
  //
  // `timelinePanelHeightPx` is in the dep list on purpose, even though the
  // ResizeObserver below already watches the same element: that state IS the
  // panel's height (the top-edge splitter writes it), so depending on it
  // re-measures synchronously, in the very commit that resizes the panel,
  // before the browser paints. The observer alone always lands a frame late
  // -- its callback fires after layout, so the frame that shrank the panel
  // still painted with the OLD height. Dragging the splitter fast enough
  // meant the centering math kept running against a stale, larger viewport:
  // the top spacer stayed sized for the old height, pushing the tracks down
  // past the bottom of the now-shorter panel and leaving a tall empty band
  // you could scroll around in, with the clips nowhere near centered.
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
  }, [setTimelineViewportWidth, isEmpty, timelinePanelHeightPx])

  const handleSelectClip = useCallback(
    (clipId: string, modifiers: ClickModifiers = {}) => {
      if (!modifiers.ctrl && !modifiers.shift) {
        selectScenes([])
        setSelectedCaptionSegmentIds([])
      }
      selectClip(clipId, modifiers)
    },
    [selectClip, selectScenes]
  )

  // Selecting a scene whose time range the playhead isn't currently inside
  // seeks to it -- a scene only ever renders in Preview while the playhead is
  // inside its [startTime, endTime) range (see GraphicsOverlay.isSceneVisibleAt),
  // so this is what makes "select a clip" reliably show it instead of
  // silently doing nothing until the user separately scrubs to it.
  const handleSelectScene = useCallback(
    (sceneId: string) => {
      clearClipSelection()
      setSelectedCaptionSegmentIds([])
      selectScene(sceneId)
      const scene = allScenes.find((s) => s.id === sceneId)
      if (scene && (currentTime < scene.startTime || currentTime >= scene.endTime)) {
        seekTo(scene.startTime)
      }
    },
    [clearClipSelection, selectScene, allScenes, currentTime, seekTo]
  )

  const handleDoubleClickClip = useCallback(
    (clip: TimelineClip) => {
      handleSelectClip(clip.id)
      seekTo(clip.startTime)
    },
    [handleSelectClip, seekTo]
  )

  const handleBladeSplit = useCallback(
    (clipId: string, atTime: number) => {
      splitClipAt(clipId, atTime, { linked: linkageOn })
    },
    [splitClipAt, linkageOn]
  )

  const handleRemoveBackground = useCallback(
    async (clip: TimelineClip) => {
      const media = mediaById[clip.mediaId]
      if (clip.type !== 'image' || !media?.originalPath || backgroundJob) return
      const jobId = `remove-bg-${crypto.randomUUID()}`
      setBackgroundError(null)
      setBackgroundJob({ clipId: clip.id, jobId, stage: 'Starting', percent: 0 })
      const result = await window.api.media.removeBackground(jobId, media.originalPath)
      setBackgroundJob(null)
      if (!result.ok) {
        if (!result.canceled) setBackgroundError(result.error)
        return
      }
      pendingReplaceRef.current = { clipId: clip.id, path: result.outputPath }
      await importPaths([result.outputPath])
    },
    [mediaById, backgroundJob, importPaths]
  )
  useEffect(
    () =>
      window.api.media.onRemoveBackgroundProgress((progress) => {
        setBackgroundJob((job) => (job && job.jobId === progress.jobId ? { ...job, stage: progress.stage, percent: progress.percent } : job))
      }),
    []
  )
  // Clip Properties' button asks for it by clip id.
  const removeBackgroundRef = useRef(handleRemoveBackground)
  removeBackgroundRef.current = handleRemoveBackground
  useEffect(() => {
    const onRequest = (e: Event): void => {
      const clip = sequence.clips.find((c) => c.id === (e as CustomEvent<string>).detail)
      if (clip) void removeBackgroundRef.current(clip)
    }
    window.addEventListener(REMOVE_BACKGROUND_EVENT, onRequest)
    return () => window.removeEventListener(REMOVE_BACKGROUND_EVENT, onRequest)
  }, [sequence.clips])

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

  /** "Remove Vocal" -- renders an instrumental copy of the clip's source
   * audio (see app/main/media/vocalRemoval.ts), then puts it on an audio
   * track directly under the video clip and mutes the video's own audio, so
   * what plays is the background WITHOUT the original dialogue. Keeping the
   * original clip (muted) rather than replacing it means the change is
   * undoable and the original voice is one un-mute away. */
  const handleRemoveVocal = useCallback(
    async (clip: TimelineClip): Promise<void> => {
      const media = mediaById[clip.mediaId]
      if (!media?.originalPath) return
      // Every selected clip of the same video at once (Video Sync can cut
      // one film into hundreds of clips) -- the separation is of the whole
      // file and kept, so they all share the one run.
      const targets = selectedTimelineClipIds.includes(clip.id)
        ? sequence.clips.filter((c) => selectedTimelineClipIds.includes(c.id) && c.type === 'video' && c.mediaId === clip.mediaId).map((c) => c.id)
        : [clip.id]
      setRemovingVocalsClipId(clip.id)
      const jobId = `vocal-${clip.id}-${Date.now()}`
      vocalJobIdRef.current = jobId
      try {
        // The real separator (Demucs) runs from the VoxCPM2 runtime the
        // AI Dubber is already configured with -- same per-machine setting.
        const voxcpm = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey()))
        const result = await window.api.vocalRemoval.removeVocals(jobId, media.originalPath, voxcpm.installDir, voxcpm.device)
        if (!result.ok) {
          if (!result.canceled) await confirm({ title: 'Could not remove vocals', message: result.error, confirmLabel: 'OK', hideCancel: true })
          return
        }
        // Already in Media (an earlier Remove Vocal on this video): straight on.
        const existing = items.find((item) => item.originalPath === result.outputPath && item.stage === 'ready')
        if (existing) {
          mirrorAudioUnderClips(targets, existing.id)
          return
        }
        pendingVocalRemovalRef.current = { clipIds: targets, path: result.outputPath }
        await importPaths([result.outputPath])
      } finally {
        vocalJobIdRef.current = null
        setRemovingVocalsClipId(null)
        setVocalProgress(null)
      }
    },
    [mediaById, importPaths, confirm, selectedTimelineClipIds, sequence.clips, mirrorAudioUnderClips, items]
  )

  useEffect(() => {
    const pending = pendingVocalRemovalRef.current
    if (!pending) return
    const match = items.find((item) => item.originalPath === pending.path)
    if (!match || (match.stage !== 'ready' && match.stage !== 'error')) return
    pendingVocalRemovalRef.current = null
    if (match.stage === 'error') return
    // Each clip gets the stretch of the instrumental that matches its own
    // stretch of the video (not the file from its start).
    mirrorAudioUnderClips(pending.clipIds, match.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` should retrigger this; the sequence mutators are stable context callbacks.
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
        {
          label: removingVocalsClipId === clip.id ? 'Removing Vocal…' : 'Remove Vocal',
          onClick: () => void handleRemoveVocal(clip),
          disabled: !media?.metadata?.hasAudio || removingVocalsClipId !== null
        },
        ...(clip.type === 'image'
          ? [{ label: backgroundJob?.clipId === clip.id ? 'Removing Background…' : 'Remove Background', onClick: () => void handleRemoveBackground(clip), disabled: !!backgroundJob || clip.locked }]
          : []),
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
      resetClipProperties,
      backgroundJob,
      handleRemoveBackground
    ]
  )

  /** Keyframe Animation's diamond-marker context menu -- a single "Delete
   * Keyframe" item, checked BEFORE the clip-level menu below in
   * handleContextMenu since a diamond is a small overlay nested inside the
   * clip's own DOM (see ClipTrack.tsx's ClipKeyframeOverlay). */
  const buildKeyframeMenuItems = useCallback(
    (clipId: string, property: KeyframeableProperty, keyframeId: string): ContextMenuItem[] => [
      { label: 'Delete Keyframe', onClick: () => removeKeyframe(clipId, property, keyframeId) }
    ],
    [removeKeyframe]
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
              { label: 'Remove Gap', onClick: () => removeGap(trackId, gap, linkageOn) },
              { label: 'Remove All Gaps on Track', onClick: () => removeAllGapsOnTrack(trackId, linkageOn) }
            ]
          : [])
      ]
    },
    [sequence, pasteAtTime, hasClipboardContent, addTrack, addMarkerAtTime, selectClips, currentTime, removeGap, removeAllGapsOnTrack, linkageOn]
  )

  // The subtitle row's own menus belong to the AI Dubber's subtitles: the
  // ones shown are the dubber's (or there are none yet, and the first one
  // starts them).
  const dubberOwnsCaptions = !aiDubber.state.videoMediaId || aiDubber.state.videoMediaId === selectedId
  const buildCaptionMenuItems = useCallback(
    (segmentId: string): ContextMenuItem[] => {
      const segment = aiDubber.segments.find((s) => s.id === segmentId)
      const hasText = !!(segment?.editedText ?? segment?.text ?? '').trim()
      const busy = aiDubber.segments.some((s) => aiDubber.getSegmentState(s.id).status === 'generating')
      const generateWith = (engine: DubbingEngine): ContextMenuItem => ({
        label: `Generate with ${ENGINE_LABEL[engine]}`,
        onClick: () => aiDubber.generateSegmentWith(segmentId, engine),
        disabled: !hasText || busy
      })
      return [
        { label: hasText ? 'Edit Subtitle…' : 'Edit Subtitle… (no text yet)', onClick: () => setSubtitleEditor({ segmentId, isNew: false }) },
        { separator: true, label: '' },
        generateWith('voxcpm2'),
        generateWith('edge-tts'),
        generateWith('kiritts'),
        { label: 'Generate with Voice…', onClick: () => setSubtitleEditor({ segmentId, isNew: false }), disabled: busy },
        { separator: true, label: '' },
        { label: 'Delete Subtitle', danger: true, onClick: () => aiDubber.removeSubtitle(segmentId) }
      ]
    },
    [aiDubber]
  )
  const buildCaptionRowMenuItems = useCallback(
    (atTime: number): ContextMenuItem[] => {
      const hasVideo = sequence.clips.some((clip) => clip.type === 'video')
      const selectedVideo = items.find((m) => m.id === selectedId && m.kind === 'video')?.id
      return [
        {
          label: hasVideo ? 'Add Subtitle Here' : 'Add Subtitle Here (add a video first)',
          disabled: !hasVideo,
          onClick: () => {
            const id = aiDubber.addSubtitleAt(atTime, selectedVideo)
            if (id) setSubtitleEditor({ segmentId: id, isNew: true })
          }
        },
        { separator: true, label: '' },
        ...buildEmptySpaceMenuItems(atTime, undefined)
      ]
    },
    [sequence.clips, items, selectedId, aiDubber, buildEmptySpaceMenuItems]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const target = e.target as HTMLElement
      const content = contentRef.current
      if (!content) return
      const atTime = Math.max(0, (e.clientX - content.getBoundingClientRect().left) / pixelsPerSecond)

      const keyframeEl = target.closest<HTMLElement>('[data-keyframe-id]')
      const keyframeClipEl = keyframeEl?.closest<HTMLElement>('[data-clip-id]')
      const keyframeId = keyframeEl?.dataset.keyframeId
      const keyframeProperty = keyframeEl?.dataset.keyframeProperty
      const keyframeClipId = keyframeClipEl?.dataset.clipId
      if (keyframeId && keyframeProperty && keyframeClipId) {
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: buildKeyframeMenuItems(keyframeClipId, keyframeProperty as KeyframeableProperty, keyframeId)
        })
        return
      }

      // A subtitle: edit it, voice it. The subtitle row: add one there.
      if (dubberOwnsCaptions) {
        const captionEl = target.closest<HTMLElement>('[data-caption-id]')
        const captionId = captionEl?.dataset.captionId
        if (captionId) {
          if (!selectedCaptionSegmentIds.includes(captionId)) selectCaptionSegment(captionId)
          setContextMenu({ x: e.clientX, y: e.clientY, items: buildCaptionMenuItems(captionId) })
          return
        }
        if (target.closest('[data-track-kind="caption"]')) {
          setContextMenu({ x: e.clientX, y: e.clientY, items: buildCaptionRowMenuItems(atTime) })
          return
        }
      }

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
    [pixelsPerSecond, sequence.clips, selectedTimelineClipIds, selectClip, buildClipMenuItems, buildRulerMenuItems, buildEmptySpaceMenuItems, buildKeyframeMenuItems, dubberOwnsCaptions, selectedCaptionSegmentIds, selectCaptionSegment, buildCaptionMenuItems, buildCaptionRowMenuItems]
  )

  const seekFromClientX = useCallback(
    (clientX: number, options?: SeekOptions) => {
      const content = contentRef.current
      if (!content || effectiveDuration <= 0) return
      const rect = content.getBoundingClientRect()
      const x = clientX - rect.left
      const time = Math.min(effectiveDuration, Math.max(0, x / pixelsPerSecond))
      seekTo(time, options)
    },
    [effectiveDuration, pixelsPerSecond, seekTo]
  )

  const BOX_SELECT_THRESHOLD_PX = 4

  const contentLocalPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: clientX - rect.left, y: clientY - rect.top }
  }, [])

  const boxSelectionPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const point = contentLocalPoint(clientX, clientY)
    return { ...point, x: clampBoxSelectionX(point.x, timelineItemEndTime * pixelsPerSecond) }
  }, [contentLocalPoint, timelineItemEndTime, pixelsPerSecond])

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
  // Graphics take part in box-select exactly like clips do.
  const sceneGeometries = useMemo<ClipGeometry[]>(
    () =>
      allScenes.map((s) => {
        const top = trackTopById[s.track] ?? 0
        return { id: s.id, trackId: s.track, left: s.startTime * pixelsPerSecond, right: s.endTime * pixelsPerSecond, top, bottom: top + (trackHeightById[s.track] ?? 0) }
      }),
    [allScenes, pixelsPerSecond, trackTopById, trackHeightById]
  )
  const captionGeometries = useMemo<ClipGeometry[]>(() => {
    const captionTrack = sequence.tracks.find((track) => track.kind === 'caption')
    if (!captionTrack) return []
    const top = trackTopById[captionTrack.id] ?? 0
    const bottom = top + (trackHeightById[captionTrack.id] ?? 0)
    return segments.map((segment) => ({ id: segment.id, trackId: captionTrack.id, left: segment.startTime * pixelsPerSecond, right: segment.endTime * pixelsPerSecond, top, bottom }))
  }, [segments, sequence.tracks, pixelsPerSecond, trackTopById, trackHeightById])

  /** The fields the drag handlers read -- satisfied by both React's
   * synthetic MouseEvent and the native one from the window listeners. */
  type PointerLike = { clientX: number; clientY: number; button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: EventTarget | null; preventDefault: () => void }

  // Once a drag starts here it is tracked on `window`, not just on
  // .timeline-content: the browser keeps delivering mousemove/mouseup to
  // the page while the button is held, even with the pointer past the
  // Timeline's edge or outside the app window. Before this the content's
  // own onMouseLeave cancelled the drag the moment the pointer crossed its
  // border, so scrubbing the playhead off the end of the Timeline (or a
  // fast box-select toward the panel edge) just died mid-gesture.
  const windowDragCleanupRef = useRef<(() => void) | null>(null)

  // Edge auto-scroll: while a scrub / box / range drag holds the pointer
  // within EDGE_AUTOSCROLL_ZONE_PX of the visible content's left or right
  // edge (or past it), the Timeline scrolls sideways every frame -- faster
  // the further out the pointer is -- and the drag is re-committed at the
  // pointer's unchanged screen position, so the playhead / box keeps
  // pace with the new content underneath it. Runs as its own rAF loop for
  // the life of the drag; a pointer in the middle just makes each tick a
  // no-op.
  const edgeScrollRafRef = useRef<number | null>(null)
  const stopEdgeAutoScroll = (): void => {
    if (edgeScrollRafRef.current !== null) cancelAnimationFrame(edgeScrollRafRef.current)
    edgeScrollRafRef.current = null
  }
  const startEdgeAutoScroll = (): void => {
    if (edgeScrollRafRef.current !== null) return
    const tick = (): void => {
      edgeScrollRafRef.current = null
      const scrollEl = scrollRef.current
      const latest = latestPointerMoveRef.current
      const mode = draggingRef.current
      if (!scrollEl || !latest || !mode || mode === 'pan') return
      const rect = scrollEl.getBoundingClientRect()
      const leftEdge = rect.left + trackHeaderWidth
      const rightEdge = rect.right
      let dx = 0
      if (latest.clientX < leftEdge + EDGE_AUTOSCROLL_ZONE_PX) dx = -edgeAutoScrollSpeed(leftEdge + EDGE_AUTOSCROLL_ZONE_PX - latest.clientX)
      else if (latest.clientX > rightEdge - EDGE_AUTOSCROLL_ZONE_PX) dx = edgeAutoScrollSpeed(latest.clientX - (rightEdge - EDGE_AUTOSCROLL_ZONE_PX))
      if (dx !== 0) {
        const before = scrollEl.scrollLeft
        scrollEl.scrollLeft = before + dx
        if (scrollEl.scrollLeft !== before) commitPointerMove(latest)
      }
      edgeScrollRafRef.current = requestAnimationFrame(tick)
    }
    edgeScrollRafRef.current = requestAnimationFrame(tick)
  }

  const trackDragOnWindow = (): void => {
    windowDragCleanupRef.current?.()
    const onUp = (ev: MouseEvent): void => {
      windowDragCleanupRef.current?.()
      stopDragging(ev)
    }
    const onMove = (ev: MouseEvent): void => {
      // The button is already up but no mouseup reached us -- it was
      // swallowed by a child's stopPropagation, or released over another
      // window. The next movement ends the drag where the pointer is, so
      // a marquee never stays painted after the mouse is let go.
      if (ev.buttons === 0) {
        onUp(ev)
        return
      }
      handlePointerMove(ev)
    }
    // A window losing focus mid-drag (Alt+Tab, a dialog) also ends it.
    const onBlur = (): void => {
      const latest = latestPointerMoveRef.current
      windowDragCleanupRef.current?.()
      if (latest) stopDragging({ ...latest, ctrlKey: false, metaKey: false, shiftKey: false })
      else {
        draggingRef.current = false
        boxStartRef.current = null
        setBoxRect(null)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onBlur)
    windowDragCleanupRef.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onBlur)
      stopEdgeAutoScroll()
      windowDragCleanupRef.current = null
    }
    startEdgeAutoScroll()
  }
  useEffect(() => () => windowDragCleanupRef.current?.(), [])

  // Follow playback without the old full-page jump at the right edge. Once
  // the playhead reaches the forward guide, ease the viewport a small amount
  // each frame so clips/ruler move steadily rather than visibly jolting.
  // Only while playing: a manual seek/scrub is the user's own view choice.
  useEffect(() => {
    if (!isPlaying) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const playheadX = currentTime * pixelsPerSecond
    const viewLeft = scrollEl.scrollLeft
    const viewWidth = scrollEl.clientWidth - trackHeaderWidth
    if (viewWidth <= 0) return
    const next = nextPlaybackScrollLeft(playheadX, viewLeft, viewWidth)
    if (Math.abs(next - viewLeft) >= 0.25) scrollEl.scrollLeft = next
  }, [isPlaying, currentTime, pixelsPerSecond, trackHeaderWidth])

  const handlePointerDown = (e: PointerLike): void => {
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
      trackDragOnWindow()
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
      trackDragOnWindow()
      return
    }
    if (tool === 'range') {
      draggingRef.current = 'range'
      const t = dropTimeFromClientX(e.clientX)
      rangeStartTimeRef.current = t
      setRangeSelection({ start: t, end: t })
      trackDragOnWindow()
      return
    }
    // Ruler drags (and grabbing the playhead's own handle) scrub the playhead
    // (existing behavior); everywhere else starts a POTENTIAL box-select --
    // it isn't committed to one until the pointer actually moves (see
    // handlePointerMove), so a plain click still just clears selection +
    // seeks like before.
    if ((e.target as HTMLElement).closest('.timeline-ruler, .timeline-playhead-handle')) {
      draggingRef.current = 'scrub'
      resumeAfterScrubRef.current = isPlaying
      if (isPlaying) setPlaying(false)
      seekFromClientX(e.clientX)
      trackDragOnWindow()
      return
    }
    // A press on an item (clip, caption, graphics scene) belongs to that
    // item's own drag -- never the start of a marquee. The item handlers
    // cancel the compat mousedown themselves; this is the backstop for any
    // that don't, so a box can never appear over an item being grabbed.
    if ((e.target as HTMLElement).closest('.clip-track-clip, .timeline-caption-block, .graphics-clip')) return
    draggingRef.current = 'maybe-box'
    boxStartRef.current = boxSelectionPoint(e.clientX, e.clientY)
    trackDragOnWindow()
  }

  const handlePointerMove = (e: { clientX: number; clientY: number }): void => {
    if (draggingRef.current) latestPointerMoveRef.current = { clientX: e.clientX, clientY: e.clientY }
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
    if (draggingRef.current === 'scrub' || draggingRef.current === 'range' || draggingRef.current === 'maybe-box' || draggingRef.current === 'box') {
      // Scrubbing the playhead used to call seekFromClientX synchronously on
      // every raw mousemove -- browsers dispatch far more of these than one
      // per animation frame, and each one triggers a full Timeline
      // re-render (every clip/track recomputed), which is exactly the
      // per-pixel-state cost this same batching already eliminated for box-
      // select/range-select drags. Routing 'scrub' through the identical
      // one-commit-per-frame path makes playhead dragging just as smooth.
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
    if (draggingRef.current === 'scrub') {
      // `live: true` lets PreviewPlayer.tsx throttle the actual, expensive
      // <video> decoder seek separately from this per-frame playhead
      // update -- see SeekOptions' own doc comment. stopDragging fires one
      // final non-live seek on release for a precise landing position.
      seekFromClientX(e.clientX, { live: true })
      return
    }
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
      const { x, y } = boxSelectionPoint(e.clientX, e.clientY)
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
    const { x, y } = boxSelectionPoint(e.clientX, e.clientY)
    const rect = normalizeRect(start.x, start.y, x, y)
    const hitIds = clipsInRect(rect, clipGeometries)
    const modifiers = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }
    selectClips(applyBoxSelection(selectedTimelineClipIds, hitIds, modifiers))
    selectScenes(applyBoxSelection(selectedSceneIds, clipsInRect(rect, sceneGeometries), modifiers))
    setSelectedCaptionSegmentIds(applyBoxSelection(selectedCaptionSegmentIds, clipsInRect(rect, captionGeometries), modifiers))
  }

  const stopDragging = (e: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void => {
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
    if (draggingRef.current === 'scrub') {
      // The drag itself only ever issued `live` (throttleable) seeks -- one
      // final full-precision seek on release guarantees the video actually
      // lands exactly where the pointer did, not wherever the last
      // throttled frame happened to leave it.
      seekFromClientX(e.clientX)
      draggingRef.current = false
      if (resumeAfterScrubRef.current) {
        resumeAfterScrubRef.current = false
        setPlaying(true)
      }
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
      selectScenes([])
      setSelectedCaptionSegmentIds([])
      seekFromClientX(e.clientX)
    }
    draggingRef.current = false
    boxStartRef.current = null
    setBoxRect(null)
  }

  /** Pointer left .timeline-content: only the hover-only skimmer line
   * needs hiding -- an in-progress drag keeps going on the window
   * listeners (see trackDragOnWindow). */
  const handleContentMouseLeave = (): void => {
    if (skimmerRef.current) skimmerRef.current.style.display = 'none'
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

  // Same "visually fill the viewport" treatment as the ruler above (in
  // pixels directly, since this feeds a track row's own DOM width instead of
  // a duration prop) -- without it, a track row's own div (and its bottom
  // divider) stopped exactly at `effectiveDuration * pixelsPerSecond`, short
  // of the viewport on a short project, while the header column's own
  // (always full-column-width) row divider kept going the rest of the way:
  // the two columns' divider lines looked continuous on the header side and
  // just stopped, mid-row, on the content side.
  const trackRowVisualMinWidthPx = Math.max(0, timelineViewportWidth - trackHeaderWidth)

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
      scrollLeftRef.current = scrollEl.scrollLeft
      const start = Math.max(0, (scrollEl.scrollLeft - marginPx) / pixelsPerSecond)
      const end = (scrollEl.scrollLeft + scrollEl.clientWidth + marginPx) / pixelsPerSecond
      // ResizeObserver/layout effects can legitimately report the same
      // rectangle more than once. Reusing the previous object prevents an
      // identical measurement from scheduling another render and makes this
      // tracker resilient if any upstream layout dependency changes identity.
      setViewportRange((previous) =>
        previous && previous.start === start && previous.end === end ? previous : { start, end }
      )

      // CSS can pin a sticky row but cannot expose whether it is currently
      // pinned. Derive that state from the Main Track's natural layout
      // position so the stronger colour/shadow appears ONLY while the row
      // is floating at the viewport bottom, never in its normal position.
      const mainTrack = sortedTracks.find((track) => track.isMain)
      const mainTop = mainTrack ? trackTopById[mainTrack.id] : undefined
      const mainHeight = mainTrack ? trackHeightById[mainTrack.id] : undefined
      const floating = mainTop !== undefined && mainHeight !== undefined && mainTop + mainHeight > scrollEl.scrollTop + scrollEl.clientHeight + 1
      timelineRootRef.current?.classList.toggle('timeline-main-track-floating', floating)
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
  }, [pixelsPerSecond, isEmpty, sortedTracks, trackTopById, trackHeightById])

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
        <TimelineToolbar onZoom={zoomAroundPlayhead} timelineDuration={effectiveDuration} onDeleteSelection={deleteAllSelectedTimelineItems} hasAdditionalSelection={selectedCaptionSegmentIds.length > 0} />
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
  // From the recorded scroll position and the measured viewport width --
  // never the element itself: reading its scrollLeft/clientWidth here
  // forced a full layout on every render (every playback tick, every
  // AI Dubber change), the main cost of a Detect Gender click on a long
  // project.
  const playheadBadgeEdgeClass = ((): string => {
    if (!scrollRef.current || timelineViewportWidth <= 0) return ''
    const scrollLeft = scrollLeftRef.current
    const edge = playheadBadgeEdge(currentTime * pixelsPerSecond, scrollLeft, scrollLeft + timelineViewportWidth)
    return edge ? ` timeline-playhead-badge-${edge}-edge` : ''
  })()

  return (
    // Overriding --timeline-top-safe-zone here (rather than only using
    // safeZonePx in the JS geometry) is what actually shrinks the rendered
    // band: both the content column's .timeline-top-safe-zone and the header
    // column's .timeline-header-safe-zone-spacer size themselves off this
    // variable, and --timeline-content-start is defined as a calc() over it,
    // so every sticky offset derived from it follows along automatically.
    <div ref={timelineRootRef} className="timeline-root" style={{ ['--timeline-top-safe-zone' as string]: `${safeZonePx}px` } as CSSProperties}>
      <TimelineToolbar onZoom={zoomAroundPlayhead} timelineDuration={effectiveDuration} onDeleteSelection={deleteAllSelectedTimelineItems} hasAdditionalSelection={selectedCaptionSegmentIds.length > 0} />
      {/* Remove Vocal runs for seconds to minutes (a real separation
          model); before this the only sign anything was happening was a
          greyed-out menu item nobody could see once the menu closed. */}
      {backgroundJob && (
        <div className="timeline-job-pill" role="status" aria-live="polite">
          <span className="timeline-job-pill-spinner" />
          <span className="timeline-job-pill-label">Removing background · {backgroundJob.stage}</span>
          <span className="timeline-job-pill-track">
            <span className="timeline-job-pill-fill" style={{ width: `${backgroundJob.percent}%` }} />
          </span>
          <span className="timeline-job-pill-percent">{Math.round(backgroundJob.percent)}%</span>
          <button className="timeline-job-pill-cancel" title="Stop" aria-label="Stop removing the background" onClick={() => void window.api.media.cancelRemoveBackground(backgroundJob.jobId)}>
            ✕
          </button>
        </div>
      )}
      {backgroundError && !backgroundJob && (
        <div className="timeline-job-pill timeline-job-pill-error" role="alert">
          <span className="timeline-job-pill-label">Remove Background: {backgroundError}</span>
          <button className="timeline-job-pill-cancel" title="Close" aria-label="Close" onClick={() => setBackgroundError(null)}>
            ✕
          </button>
        </div>
      )}
      {removingVocalsClipId && (
        <div className="timeline-job-pill" role="status" aria-live="polite">
          <span className="timeline-job-pill-spinner" />
          <span className="timeline-job-pill-label">Removing vocals · {vocalProgress?.stage ?? 'Starting'}</span>
          <span className="timeline-job-pill-track">
            <span className="timeline-job-pill-fill" style={{ width: `${vocalProgress?.percent ?? 0}%` }} />
          </span>
          <span className="timeline-job-pill-percent">{Math.round(vocalProgress?.percent ?? 0)}%</span>
          <button
            className="timeline-job-pill-cancel"
            title="Stop removing vocals"
            aria-label="Stop removing vocals"
            onClick={() => {
              if (vocalJobIdRef.current) void window.api.vocalRemoval.cancel(vocalJobIdRef.current)
            }}
          >
            ✕
          </button>
        </div>
      )}
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
          <TimelineTrackHeaders
            tracks={sortedTracks}
            iconKindByTrackId={trackIconKindById}
            trackHasContent={trackHasContent}
            topSpacerHeight={topSpacerHeight}
            bottomSpacerHeight={bottomSpacerHeight}
          />
        </div>
        <div className="timeline-content-column">
          <div
            className="timeline-content"
            ref={contentRef}
            style={{ width: contentWidth }}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={stopDragging}
            onMouseLeave={handleContentMouseLeave}
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
                    visualMinWidthPx={trackRowVisualMinWidthPx}
                    pixelsPerSecond={pixelsPerSecond}
                    selectedSceneId={selectedSceneId}
                    selectedSceneIds={selectedSceneIds}
                    onSelect={handleSelectScene}
                    onRetime={(sceneId, start, end, options) => retimeScene(sceneMediaIdById[sceneId] ?? '', sceneId, start, end, options)}
                    onSnapGuide={updateSnapGuide}
                  />
                )
              }
              if (track.kind === 'caption') {
                return (
                  <CaptionsTrack
                    key={track.id}
                    segments={segments}
                    visibleSegments={visibleCaptionSegments}
                    duration={effectiveDuration}
                    visualMinWidthPx={trackRowVisualMinWidthPx}
                    pixelsPerSecond={pixelsPerSecond}
                    activeSegmentId={activeSegmentId}
                    selectedSegmentIds={selectedCaptionSegmentIds}
                    onSelect={selectCaptionSegment}
                    onSeek={seekTo}
                    onMove={
                      selectedId
                        ? (segmentId, newStartTime) => {
                            // A subtitle the AI Dubber has dubbed drags its
                            // voice clip along with it; any other transcript
                            // just moves the caption.
                            if (aiDubber.state.videoMediaId === selectedId) aiDubber.moveSubtitle(segmentId, newStartTime)
                            else moveSegment(selectedId, segmentId, newStartTime)
                          }
                        : undefined
                    }
                    onMoveSet={
                      selectedId
                        ? (segmentIds, draggedSegmentId, newStartTime) => {
                            if (aiDubber.state.videoMediaId === selectedId) {
                              aiDubber.moveSubtitles(segmentIds, draggedSegmentId, newStartTime)
                            } else {
                              moveSegments(selectedId, segmentIds, draggedSegmentId, newStartTime)
                            }
                          }
                        : undefined
                    }
                    height={trackDisplayHeight(track, trackHeightMode)}
                    hidden={track.hidden}
                  />
                )
              }
              // video / audio
              const clips = clipsByTrackId[track.id] ?? []
              const visibleClips = visibleClipsByTrackId[track.id] ?? clips
              return (
                <div
                  key={track.id}
                  className={`timeline-track-row-wrapper${track.isMain ? ' timeline-track-row-wrapper-sticky-main' : ''}`}
                >
                  <ClipTrack
                    track={track}
                    clips={visibleClips}
                    allClips={sequence.clips}
                    tracks={sequence.tracks}
                    markers={sequence.markers}
                    mediaById={mediaById}
                    duration={effectiveDuration}
                    visualMinWidthPx={trackRowVisualMinWidthPx}
                    pixelsPerSecond={pixelsPerSecond}
                    selectedClipIds={selectedTimelineClipIds}
                    onSelect={handleSelectClip}
                    onDoubleClick={handleDoubleClickClip}
                    onMove={moveClip}
                    onMoveSet={moveClipSet}
                    onTrim={trimClip}
                    onBladeSplit={handleBladeSplit}
                    onRollEdit={rollEditClips}
                    onSnapGuide={updateSnapGuide}
                    draggingClipId={draggingClipId}
                    onDraggingChange={setDraggingClipId}
                    takeLabels={isNarrationTrackId(track.id) ? narrationTakeLabels : undefined}
                    liveRecordingRegion={track.id === NARRATION_TRACK_ID ? narrationLiveRecordingRegion : null}
                  />
                  {track.kind === 'audio' && clips.length === 0 && (
                    <span className="timeline-track-empty-label">No audio on this track</span>
                  )}
                </div>
              )
            })}
              <div className="timeline-tracks-spacer" style={{ height: bottomSpacerHeight }} />
            </div>

            <div className="timeline-playhead" style={{ transform: `translate3d(${currentTime * pixelsPerSecond}px, 0, 0)` }}>
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
      {subtitleEditor && <SubtitleQuickEditor key={subtitleEditor.segmentId} segmentId={subtitleEditor.segmentId} isNew={subtitleEditor.isNew} onClose={closeSubtitleEditor} />}
    </div>
  )
}

