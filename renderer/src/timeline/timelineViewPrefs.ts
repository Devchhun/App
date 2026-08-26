// Pure logic for Timeline view/editing-mode preferences -- zoom, panel/
// track-header dimensions, and the CapCut-style toggle states (Magnet,
// Ripple+scope, Linkage, Snapping, Skimmer, tool mode, overwrite mode,
// waveform/compact-height display options). Persisted to localStorage as a
// per-machine editing preference (mirrors renderer/src/nav/workspaceLayout.ts
// exactly: versioned key, no migrator, per-field fallback to defaults on any
// parse error/missing/out-of-range value) -- deliberately NOT written into
// the project file or Undo history, since these are how-you-like-to-edit
// preferences, not part of the video being edited. Markers, track ordering,
// and track heights ARE real project content and live in ProjectSequence
// instead (see shared/project.ts), not here.

export type RippleScope = 'current' | 'linked' | 'all-unlocked'
export type TimelineTool = 'select' | 'blade' | 'hand' | 'range' | 'roll'
export type OverwriteMode = 'stack' | 'insert' | 'overwrite'
export type TrackHeightMode = 'compact' | 'normal' | 'tall'

export interface TimelineViewPrefs {
  pixelsPerSecond: number
  trackHeaderWidth: number
  timelinePanelHeightPx: number
  magnetOn: boolean
  rippleOn: boolean
  rippleScope: RippleScope
  linkageOn: boolean
  snappingOn: boolean
  skimmerOn: boolean
  tool: TimelineTool
  overwriteMode: OverwriteMode
  showWaveforms: boolean
  trackHeightMode: TrackHeightMode
}

export const MIN_PPS = 2
export const MAX_PPS = 400
const DEFAULT_PPS = 20

// Narrowed for the compact, icon-only header row (see
// TimelineTrackHeaders.tsx) -- there's no text label to make room for
// anymore, just a handful of small icons, matching the reference editor's
// narrow header strip instead of the old text-label-forward width range.
export const TRACK_HEADER_WIDTH_MIN = 92
export const TRACK_HEADER_WIDTH_MAX = 340
const TRACK_HEADER_WIDTH_DEFAULT = 112

export const TIMELINE_PANEL_HEIGHT_MIN = 220
export const TIMELINE_PANEL_HEIGHT_MAX = 640
const TIMELINE_PANEL_HEIGHT_DEFAULT = 285

export const DEFAULT_TIMELINE_VIEW_PREFS: TimelineViewPrefs = {
  pixelsPerSecond: DEFAULT_PPS,
  trackHeaderWidth: TRACK_HEADER_WIDTH_DEFAULT,
  timelinePanelHeightPx: TIMELINE_PANEL_HEIGHT_DEFAULT,
  // Magnet/Snapping/Linkage default ON to match CapCut's own defaults and
  // (for Linkage specifically) preserve this app's pre-existing always-on
  // linked-clip move/split cascade until a user explicitly turns it off.
  magnetOn: true,
  rippleOn: false,
  rippleScope: 'current',
  linkageOn: true,
  snappingOn: true,
  skimmerOn: false,
  tool: 'select',
  overwriteMode: 'stack',
  showWaveforms: true,
  trackHeightMode: 'normal'
}

export function clampPixelsPerSecond(pps: number): number {
  if (!Number.isFinite(pps)) return DEFAULT_PPS
  return Math.min(MAX_PPS, Math.max(MIN_PPS, pps))
}

export function clampTrackHeaderWidth(px: number): number {
  if (!Number.isFinite(px)) return TRACK_HEADER_WIDTH_DEFAULT
  return Math.min(TRACK_HEADER_WIDTH_MAX, Math.max(TRACK_HEADER_WIDTH_MIN, px))
}

export function clampTimelinePanelHeight(px: number): number {
  if (!Number.isFinite(px)) return TIMELINE_PANEL_HEIGHT_DEFAULT
  return Math.min(TIMELINE_PANEL_HEIGHT_MAX, Math.max(TIMELINE_PANEL_HEIGHT_MIN, px))
}

const RIPPLE_SCOPES: RippleScope[] = ['current', 'linked', 'all-unlocked']
const TOOLS: TimelineTool[] = ['select', 'blade', 'hand', 'range', 'roll']
const OVERWRITE_MODES: OverwriteMode[] = ['stack', 'insert', 'overwrite']
const TRACK_HEIGHT_MODES: TrackHeightMode[] = ['compact', 'normal', 'tall']

const STORAGE_KEY = 'cae-timeline-view-prefs-v1'

export function getTimelineViewPrefsStorageKey(): string {
  return STORAGE_KEY
}

/** Parses a raw localStorage value into a valid TimelineViewPrefs. Any parse
 * error, missing field, or invalid value falls back to that field's default
 * individually -- a corrupt/old value never breaks the whole preference set. */
export function parseStoredTimelineViewPrefs(raw: string | null): TimelineViewPrefs {
  if (!raw) return DEFAULT_TIMELINE_VIEW_PREFS
  try {
    const parsed = JSON.parse(raw) as Partial<TimelineViewPrefs>
    return {
      pixelsPerSecond: typeof parsed.pixelsPerSecond === 'number' ? clampPixelsPerSecond(parsed.pixelsPerSecond) : DEFAULT_TIMELINE_VIEW_PREFS.pixelsPerSecond,
      trackHeaderWidth: typeof parsed.trackHeaderWidth === 'number' ? clampTrackHeaderWidth(parsed.trackHeaderWidth) : DEFAULT_TIMELINE_VIEW_PREFS.trackHeaderWidth,
      timelinePanelHeightPx:
        typeof parsed.timelinePanelHeightPx === 'number' ? clampTimelinePanelHeight(parsed.timelinePanelHeightPx) : DEFAULT_TIMELINE_VIEW_PREFS.timelinePanelHeightPx,
      magnetOn: typeof parsed.magnetOn === 'boolean' ? parsed.magnetOn : DEFAULT_TIMELINE_VIEW_PREFS.magnetOn,
      rippleOn: typeof parsed.rippleOn === 'boolean' ? parsed.rippleOn : DEFAULT_TIMELINE_VIEW_PREFS.rippleOn,
      rippleScope: RIPPLE_SCOPES.includes(parsed.rippleScope as RippleScope) ? (parsed.rippleScope as RippleScope) : DEFAULT_TIMELINE_VIEW_PREFS.rippleScope,
      linkageOn: typeof parsed.linkageOn === 'boolean' ? parsed.linkageOn : DEFAULT_TIMELINE_VIEW_PREFS.linkageOn,
      snappingOn: typeof parsed.snappingOn === 'boolean' ? parsed.snappingOn : DEFAULT_TIMELINE_VIEW_PREFS.snappingOn,
      skimmerOn: typeof parsed.skimmerOn === 'boolean' ? parsed.skimmerOn : DEFAULT_TIMELINE_VIEW_PREFS.skimmerOn,
      tool: TOOLS.includes(parsed.tool as TimelineTool) ? (parsed.tool as TimelineTool) : DEFAULT_TIMELINE_VIEW_PREFS.tool,
      overwriteMode: OVERWRITE_MODES.includes(parsed.overwriteMode as OverwriteMode) ? (parsed.overwriteMode as OverwriteMode) : DEFAULT_TIMELINE_VIEW_PREFS.overwriteMode,
      showWaveforms: typeof parsed.showWaveforms === 'boolean' ? parsed.showWaveforms : DEFAULT_TIMELINE_VIEW_PREFS.showWaveforms,
      trackHeightMode: TRACK_HEIGHT_MODES.includes(parsed.trackHeightMode as TrackHeightMode) ? (parsed.trackHeightMode as TrackHeightMode) : DEFAULT_TIMELINE_VIEW_PREFS.trackHeightMode
    }
  } catch {
    return DEFAULT_TIMELINE_VIEW_PREFS
  }
}

export function serializeTimelineViewPrefs(prefs: TimelineViewPrefs): string {
  return JSON.stringify(prefs)
}
