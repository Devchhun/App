import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  DEFAULT_TIMELINE_VIEW_PREFS,
  parseStoredTimelineViewPrefs,
  serializeTimelineViewPrefs,
  clampPixelsPerSecond,
  clampTrackHeaderWidth,
  clampTimelinePanelHeight,
  getTimelineViewPrefsStorageKey,
  MIN_PPS,
  MAX_PPS,
  type RippleScope,
  type TimelineTool,
  type OverwriteMode,
  type TrackHeightMode
} from './timelineViewPrefs'

export { MIN_PPS, MAX_PPS }
export type { RippleScope, TimelineTool, OverwriteMode, TrackHeightMode }

interface TimelineViewContextValue {
  pixelsPerSecond: number
  setPixelsPerSecond: Dispatch<SetStateAction<number>>
  /** Rendered pixel width of the Timeline's horizontal scroll viewport, kept
   * in sync by Timeline.tsx -- lets the toolbar (now hosted in the Preview
   * panel) compute "zoom to fit" without needing a DOM ref into a different panel. */
  timelineViewportWidth: number
  setTimelineViewportWidth: (width: number) => void

  /** All fields below are per-machine editing preferences, persisted to
   * localStorage (see timelineViewPrefs.ts) -- never written to the project
   * file or Undo history. Toggles are wired to real behavior in later work;
   * this context is where they live and persist regardless. */
  trackHeaderWidth: number
  setTrackHeaderWidth: (px: number) => void
  timelinePanelHeightPx: number
  setTimelinePanelHeightPx: (px: number) => void

  magnetOn: boolean
  toggleMagnet: () => void
  rippleOn: boolean
  toggleRipple: () => void
  rippleScope: RippleScope
  setRippleScope: (scope: RippleScope) => void
  linkageOn: boolean
  toggleLinkage: () => void
  snappingOn: boolean
  toggleSnapping: () => void
  skimmerOn: boolean
  toggleSkimmer: () => void
  tool: TimelineTool
  setTool: (tool: TimelineTool) => void
  overwriteMode: OverwriteMode
  setOverwriteMode: (mode: OverwriteMode) => void
  showWaveforms: boolean
  toggleShowWaveforms: () => void
  trackHeightMode: TrackHeightMode
  setTrackHeightMode: (mode: TrackHeightMode) => void

  /** Range tool's current time-range selection (spec section 4) --
   * sequence-absolute seconds, start<=end. Deliberately transient (like
   * playhead position), NOT persisted to localStorage or the project file. */
  rangeSelection: { start: number; end: number } | null
  setRangeSelection: (range: { start: number; end: number } | null) => void
}

const TimelineViewContext = createContext<TimelineViewContextValue | null>(null)

function readInitialPrefs(): typeof DEFAULT_TIMELINE_VIEW_PREFS {
  if (typeof localStorage === 'undefined') return DEFAULT_TIMELINE_VIEW_PREFS
  try {
    return parseStoredTimelineViewPrefs(localStorage.getItem(getTimelineViewPrefsStorageKey()))
  } catch {
    return DEFAULT_TIMELINE_VIEW_PREFS
  }
}

export function TimelineViewProvider({ children }: { children: ReactNode }): JSX.Element {
  const initial = useMemo(readInitialPrefs, [])

  const [pixelsPerSecond, setPixelsPerSecond] = useState(initial.pixelsPerSecond)
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(800)
  const [trackHeaderWidth, setTrackHeaderWidthState] = useState(initial.trackHeaderWidth)
  const [timelinePanelHeightPx, setTimelinePanelHeightPxState] = useState(initial.timelinePanelHeightPx)
  const [magnetOn, setMagnetOn] = useState(initial.magnetOn)
  const [rippleOn, setRippleOn] = useState(initial.rippleOn)
  const [rippleScope, setRippleScope] = useState<RippleScope>(initial.rippleScope)
  const [linkageOn, setLinkageOn] = useState(initial.linkageOn)
  const [snappingOn, setSnappingOn] = useState(initial.snappingOn)
  const [skimmerOn, setSkimmerOn] = useState(initial.skimmerOn)
  const [tool, setTool] = useState<TimelineTool>(initial.tool)
  const [overwriteMode, setOverwriteMode] = useState<OverwriteMode>(initial.overwriteMode)
  const [showWaveforms, setShowWaveforms] = useState(initial.showWaveforms)
  const [trackHeightMode, setTrackHeightMode] = useState<TrackHeightMode>(initial.trackHeightMode)
  const [rangeSelection, setRangeSelection] = useState<{ start: number; end: number } | null>(null)

  // One persistence effect for the whole preference set, mirroring
  // useWorkspaceLayout.ts's exact pattern (no debounce, try/catch around a
  // storage write that can't affect the in-memory session either way).
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(
        getTimelineViewPrefsStorageKey(),
        serializeTimelineViewPrefs({
          pixelsPerSecond,
          trackHeaderWidth,
          timelinePanelHeightPx,
          magnetOn,
          rippleOn,
          rippleScope,
          linkageOn,
          snappingOn,
          skimmerOn,
          tool,
          overwriteMode,
          showWaveforms,
          trackHeightMode
        })
      )
    } catch {
      // Storage unavailable/full -- the in-memory prefs still work for this session.
    }
  }, [
    pixelsPerSecond,
    trackHeaderWidth,
    timelinePanelHeightPx,
    magnetOn,
    rippleOn,
    rippleScope,
    linkageOn,
    snappingOn,
    skimmerOn,
    tool,
    overwriteMode,
    showWaveforms,
    trackHeightMode
  ])

  const setTrackHeaderWidth = useCallback((px: number) => setTrackHeaderWidthState(clampTrackHeaderWidth(px)), [])
  const setTimelinePanelHeightPx = useCallback((px: number) => setTimelinePanelHeightPxState(clampTimelinePanelHeight(px)), [])
  const toggleMagnet = useCallback(() => setMagnetOn((v) => !v), [])
  const toggleRipple = useCallback(() => setRippleOn((v) => !v), [])
  const toggleLinkage = useCallback(() => setLinkageOn((v) => !v), [])
  const toggleSnapping = useCallback(() => setSnappingOn((v) => !v), [])
  const toggleSkimmer = useCallback(() => setSkimmerOn((v) => !v), [])
  const toggleShowWaveforms = useCallback(() => setShowWaveforms((v) => !v), [])

  const value = useMemo<TimelineViewContextValue>(
    () => ({
      pixelsPerSecond,
      setPixelsPerSecond: (update) => setPixelsPerSecond((prev) => clampPixelsPerSecond(typeof update === 'function' ? (update as (p: number) => number)(prev) : update)),
      timelineViewportWidth,
      setTimelineViewportWidth,
      trackHeaderWidth,
      setTrackHeaderWidth,
      timelinePanelHeightPx,
      setTimelinePanelHeightPx,
      magnetOn,
      toggleMagnet,
      rippleOn,
      toggleRipple,
      rippleScope,
      setRippleScope,
      linkageOn,
      toggleLinkage,
      snappingOn,
      toggleSnapping,
      skimmerOn,
      toggleSkimmer,
      tool,
      setTool,
      overwriteMode,
      setOverwriteMode,
      showWaveforms,
      toggleShowWaveforms,
      trackHeightMode,
      setTrackHeightMode,
      rangeSelection,
      setRangeSelection
    }),
    [
      pixelsPerSecond,
      timelineViewportWidth,
      trackHeaderWidth,
      setTrackHeaderWidth,
      timelinePanelHeightPx,
      setTimelinePanelHeightPx,
      magnetOn,
      toggleMagnet,
      rippleOn,
      toggleRipple,
      rippleScope,
      linkageOn,
      toggleLinkage,
      snappingOn,
      toggleSnapping,
      skimmerOn,
      toggleSkimmer,
      tool,
      overwriteMode,
      showWaveforms,
      toggleShowWaveforms,
      trackHeightMode,
      setTrackHeightMode,
      rangeSelection
    ]
  )

  return <TimelineViewContext.Provider value={value}>{children}</TimelineViewContext.Provider>
}

export function useTimelineView(): TimelineViewContextValue {
  const ctx = useContext(TimelineViewContext)
  if (!ctx) throw new Error('useTimelineView must be used within TimelineViewProvider')
  return ctx
}
