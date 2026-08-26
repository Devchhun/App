import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useTimelineView, MIN_PPS, MAX_PPS } from './TimelineViewContext'
import { useTimelineShortcuts } from './useTimelineShortcuts'
import { useUiState } from '../nav/UiStateContext'
import { TimeRuler } from './TimeRuler'
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

const RULER_HEIGHT_PX = 20

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
  const headerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
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

  // Cumulative row position/height per track, for the drag-drop ghost
  // preview to draw its dashed boxes against the right row (rows are plain
  // document flow, not individually positioned, so this is computed once
  // per track-list/height change rather than measured from the DOM).
  const trackTopById = useMemo(() => {
    const map: Record<string, number> = {}
    let top = RULER_HEIGHT_PX
    for (const t of sortedTracks) {
      map[t.id] = top
      top += trackDisplayHeight(t, trackHeightMode)
    }
    return map
  }, [sortedTracks, trackHeightMode])
  const trackHeightById = useMemo(() => {
    const map: Record<string, number> = {}
    for (const t of sortedTracks) map[t.id] = trackDisplayHeight(t, trackHeightMode)
    return map
  }, [sortedTracks, trackHeightMode])

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

  // The toolbar's "zoom to fit" now lives in the Preview panel and can't see
  // this scroll container directly, so publish its width into shared state.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const report = (): void => setTimelineViewportWidth(el.clientWidth)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [setTimelineViewportWidth])

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
        { label: 'Cut', onClick: () => cutSelected({ linked: linkageOn }) },
        { label: 'Copy', onClick: () => copySelected() },
        { label: 'Paste', onClick: () => pasteAtTime(currentTime), disabled: !hasClipboardContent() },
        { label: 'Duplicate', onClick: () => duplicateSelected({ linked: linkageOn }) },
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
        { label: 'Delete', onClick: () => deleteSelected({ linked: linkageOn }) },
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
    if (draggingRef.current === 'range') {
      const startTime = rangeStartTimeRef.current
      if (startTime === null) return
      const t = dropTimeFromClientX(e.clientX)
      setRangeSelection({ start: Math.min(startTime, t), end: Math.max(startTime, t) })
      return
    }
    if (draggingRef.current === 'scrub') {
      seekFromClientX(e.clientX)
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
  const isEmpty = sequence.clips.length === 0 && allScenes.length === 0

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
  useEffect(() => {
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
          <TimelineTrackHeaders tracks={sortedTracks} trackHasContent={trackHasContent} />
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
            <TimeRuler duration={effectiveDuration} pixelsPerSecond={pixelsPerSecond} markers={sequence.markers} />

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
                  />
                  {track.kind === 'audio' && clips.length === 0 && (
                    <span className="timeline-track-empty-label">No audio on this track</span>
                  )}
                </div>
              )
            })}

            <div className="timeline-playhead" style={{ left: currentTime * pixelsPerSecond }}>
              <div className="timeline-playhead-handle" title="Drag to scrub" />
              <span className="timeline-playhead-badge">{formatDuration(currentTime)}</span>
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

