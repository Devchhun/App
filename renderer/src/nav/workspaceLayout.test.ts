import { describe, it, expect } from 'vitest'
import {
  clampLeftWidth,
  clampRightWidth,
  fitPanelWidthsToWindow,
  parseStoredPanelWidths,
  serializePanelWidths,
  buildWorkspaceGridColumns,
  computeSplitterOffsets,
  SPLITTER_HIT_WIDTH,
  DEFAULT_PANEL_WIDTHS,
  LEFT_PANEL_MIN,
  LEFT_PANEL_MAX,
  LEFT_PANEL_DEFAULT,
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_DEFAULT,
  PLAYER_MIN,
  type PanelWidthsState
} from './workspaceLayout'

describe('1. clampLeftWidth / clampRightWidth', () => {
  it('clamps to the documented panel width limits', () => {
    expect(clampLeftWidth(100)).toBe(LEFT_PANEL_MIN)
    expect(clampLeftWidth(9999)).toBe(LEFT_PANEL_MAX)
    expect(clampLeftWidth(480)).toBe(480)
    expect(clampRightWidth(100)).toBe(RIGHT_PANEL_MIN)
    expect(clampRightWidth(9999)).toBe(RIGHT_PANEL_MAX)
    expect(clampRightWidth(410)).toBe(410)
  })

  it('falls back to the default for non-finite input', () => {
    expect(clampLeftWidth(NaN)).toBe(LEFT_PANEL_DEFAULT)
    expect(clampRightWidth(Infinity)).toBe(RIGHT_PANEL_DEFAULT)
  })

  it('the Templates panel default is wider than the Properties panel default (redistributed from the Preview column, not the reverse)', () => {
    expect(LEFT_PANEL_DEFAULT).toBeGreaterThan(400)
    expect(RIGHT_PANEL_DEFAULT).toBeGreaterThan(350)
  })
})

describe('1. fitPanelWidthsToWindow', () => {
  it('leaves widths untouched when there is plenty of room', () => {
    const widths: PanelWidthsState = { leftWidth: 460, rightWidth: 400 }
    expect(fitPanelWidthsToWindow(widths, 2560, 72)).toEqual(widths)
  })

  it('shrinks side panels (never below their own minimum) so the Player keeps its minimum width, when the window is wide enough for that to be possible', () => {
    const widths: PanelWidthsState = { leftWidth: LEFT_PANEL_MAX, rightWidth: RIGHT_PANEL_MAX }
    const narrow = fitPanelWidthsToWindow(widths, 1600, 72)
    expect(narrow.leftWidth).toBeLessThan(LEFT_PANEL_MAX)
    expect(narrow.rightWidth).toBeLessThan(RIGHT_PANEL_MAX)
    expect(narrow.leftWidth).toBeGreaterThanOrEqual(LEFT_PANEL_MIN)
    expect(narrow.rightWidth).toBeGreaterThanOrEqual(RIGHT_PANEL_MIN)
    const totalUsed = 72 + narrow.leftWidth + narrow.rightWidth
    expect(1600 - totalUsed).toBeGreaterThanOrEqual(PLAYER_MIN - 20) // small rounding/splitter-track slack
  })

  it('never shrinks a panel below its own minimum even when the window is too narrow to also guarantee the Player minimum (an infeasible combination -- the Player yields instead)', () => {
    const widths: PanelWidthsState = { leftWidth: LEFT_PANEL_MAX, rightWidth: RIGHT_PANEL_MAX }
    const veryNarrow = fitPanelWidthsToWindow(widths, 1000, 72)
    expect(veryNarrow.leftWidth).toBeGreaterThanOrEqual(LEFT_PANEL_MIN)
    expect(veryNarrow.rightWidth).toBeGreaterThanOrEqual(RIGHT_PANEL_MIN)
  })
})

describe('2. parseStoredPanelWidths / serializePanelWidths (persisted splitter widths)', () => {
  it('round-trips a valid stored value exactly', () => {
    const widths: PanelWidthsState = { leftWidth: 470, rightWidth: 390 }
    expect(parseStoredPanelWidths(serializePanelWidths(widths))).toEqual(widths)
  })

  it('falls back to defaults for missing/corrupt storage', () => {
    expect(parseStoredPanelWidths(null)).toEqual(DEFAULT_PANEL_WIDTHS)
    expect(parseStoredPanelWidths('not json')).toEqual(DEFAULT_PANEL_WIDTHS)
    expect(parseStoredPanelWidths('{}')).toEqual(DEFAULT_PANEL_WIDTHS)
  })

  it('clamps an out-of-range stored width instead of trusting it verbatim', () => {
    const parsed = parseStoredPanelWidths(JSON.stringify({ leftWidth: 9999, rightWidth: -50 }))
    expect(parsed.leftWidth).toBe(LEFT_PANEL_MAX)
    expect(parsed.rightWidth).toBe(RIGHT_PANEL_MIN)
  })

  it('recovers individual fields independently from a partially-corrupt object', () => {
    const parsed = parseStoredPanelWidths(JSON.stringify({ leftWidth: 480 }))
    expect(parsed.leftWidth).toBe(480)
    expect(parsed.rightWidth).toBe(RIGHT_PANEL_DEFAULT)
  })
})

describe('buildWorkspaceGridColumns', () => {
  it('produces four tracks (icon rail, left, Player, right) -- no separate splitter tracks, so panels sit flush with zero gap', () => {
    const columns = buildWorkspaceGridColumns(DEFAULT_PANEL_WIDTHS, 72)
    expect(columns).toBe(`72px ${LEFT_PANEL_DEFAULT}px minmax(${PLAYER_MIN}px, 1fr) ${RIGHT_PANEL_DEFAULT}px`)
  })

  it('the Templates (left) column is wider than the Properties (right) column by default', () => {
    expect(LEFT_PANEL_DEFAULT).toBeGreaterThan(RIGHT_PANEL_DEFAULT)
  })
})

describe('computeSplitterOffsets', () => {
  it('positions the left splitter at the icon-rail + Templates-panel boundary', () => {
    const { leftSplitterLeft } = computeSplitterOffsets(DEFAULT_PANEL_WIDTHS, 72)
    expect(leftSplitterLeft).toBe(72 + LEFT_PANEL_DEFAULT)
  })

  it('positions the right splitter at the Properties-panel width, measured from the right edge', () => {
    const { rightSplitterRight } = computeSplitterOffsets(DEFAULT_PANEL_WIDTHS, 72)
    expect(rightSplitterRight).toBe(RIGHT_PANEL_DEFAULT)
  })

  it('the splitter overlay is a fixed, small hit width -- it does not grow/shrink the layout', () => {
    expect(SPLITTER_HIT_WIDTH).toBeLessThanOrEqual(6)
    expect(SPLITTER_HIT_WIDTH).toBeGreaterThanOrEqual(3)
  })

  it('clamps offsets the same way buildWorkspaceGridColumns does, staying consistent with an out-of-range stored width', () => {
    const { leftSplitterLeft } = computeSplitterOffsets({ leftWidth: 9999, rightWidth: -50 }, 72)
    expect(leftSplitterLeft).toBe(72 + LEFT_PANEL_MAX)
  })
})
