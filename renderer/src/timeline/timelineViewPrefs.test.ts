import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMELINE_VIEW_PREFS,
  parseStoredTimelineViewPrefs,
  serializeTimelineViewPrefs,
  clampPixelsPerSecond,
  clampTrackHeaderWidth,
  clampTimelinePanelHeight,
  MIN_PPS,
  MAX_PPS,
  TRACK_HEADER_WIDTH_MIN,
  TRACK_HEADER_WIDTH_MAX,
  TIMELINE_PANEL_HEIGHT_MIN,
  TIMELINE_PANEL_HEIGHT_MAX
} from './timelineViewPrefs'

describe('parseStoredTimelineViewPrefs', () => {
  it('returns defaults for null input', () => {
    expect(parseStoredTimelineViewPrefs(null)).toEqual(DEFAULT_TIMELINE_VIEW_PREFS)
  })

  it('returns defaults for malformed JSON', () => {
    expect(parseStoredTimelineViewPrefs('{not json')).toEqual(DEFAULT_TIMELINE_VIEW_PREFS)
  })

  it('round-trips a full valid prefs object', () => {
    const prefs = { ...DEFAULT_TIMELINE_VIEW_PREFS, magnetOn: false, rippleOn: true, rippleScope: 'all-unlocked' as const, tool: 'blade' as const }
    expect(parseStoredTimelineViewPrefs(serializeTimelineViewPrefs(prefs))).toEqual(prefs)
  })

  it('falls back per-field on an invalid enum value, not the whole object', () => {
    const raw = JSON.stringify({ ...DEFAULT_TIMELINE_VIEW_PREFS, rippleScope: 'bogus', magnetOn: false })
    const result = parseStoredTimelineViewPrefs(raw)
    expect(result.rippleScope).toBe(DEFAULT_TIMELINE_VIEW_PREFS.rippleScope)
    expect(result.magnetOn).toBe(false)
  })

  it('falls back per-field on an out-of-range numeric value', () => {
    const raw = JSON.stringify({ ...DEFAULT_TIMELINE_VIEW_PREFS, trackHeaderWidth: 99999 })
    expect(parseStoredTimelineViewPrefs(raw).trackHeaderWidth).toBe(TRACK_HEADER_WIDTH_MAX)
  })

  it('falls back per-field when a field is missing entirely', () => {
    const raw = JSON.stringify({ magnetOn: false })
    const result = parseStoredTimelineViewPrefs(raw)
    expect(result.magnetOn).toBe(false)
    expect(result.linkageOn).toBe(DEFAULT_TIMELINE_VIEW_PREFS.linkageOn)
    expect(result.pixelsPerSecond).toBe(DEFAULT_TIMELINE_VIEW_PREFS.pixelsPerSecond)
  })
})

describe('clamp helpers', () => {
  it('clampPixelsPerSecond stays within [MIN_PPS, MAX_PPS]', () => {
    expect(clampPixelsPerSecond(-5)).toBe(MIN_PPS)
    expect(clampPixelsPerSecond(99999)).toBe(MAX_PPS)
    expect(clampPixelsPerSecond(50)).toBe(50)
  })
  it('clampTrackHeaderWidth stays within its range', () => {
    expect(clampTrackHeaderWidth(10)).toBe(TRACK_HEADER_WIDTH_MIN)
    expect(clampTrackHeaderWidth(9999)).toBe(TRACK_HEADER_WIDTH_MAX)
  })
  it('clampTimelinePanelHeight stays within its range', () => {
    expect(clampTimelinePanelHeight(10)).toBe(TIMELINE_PANEL_HEIGHT_MIN)
    expect(clampTimelinePanelHeight(9999)).toBe(TIMELINE_PANEL_HEIGHT_MAX)
  })
  it('clamp helpers fall back to a sane default for non-finite input', () => {
    expect(clampPixelsPerSecond(NaN)).toBe(DEFAULT_TIMELINE_VIEW_PREFS.pixelsPerSecond)
  })
})
