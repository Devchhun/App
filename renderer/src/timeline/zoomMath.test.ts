import { describe, expect, it } from 'vitest'
import { computeZoomAroundCursor, zoomToRange } from './zoomMath'
import { MIN_PPS, MAX_PPS } from './timelineViewPrefs'

describe('computeZoomAroundCursor', () => {
  it('keeps the time under the cursor at the same screen position after zooming in', () => {
    const oldPps = 10
    const newPps = 20
    const scrollLeft = 100
    const cursorX = 50
    const newScrollLeft = computeZoomAroundCursor(scrollLeft, cursorX, oldPps, newPps)
    const timeAtCursorBefore = (scrollLeft + cursorX) / oldPps
    const timeAtCursorAfter = (newScrollLeft + cursorX) / newPps
    expect(timeAtCursorAfter).toBeCloseTo(timeAtCursorBefore, 5)
  })

  it('keeps the time under the cursor fixed when zooming out too', () => {
    const oldPps = 40
    const newPps = 10
    const scrollLeft = 200
    const cursorX = 30
    const newScrollLeft = computeZoomAroundCursor(scrollLeft, cursorX, oldPps, newPps)
    const timeAtCursorBefore = (scrollLeft + cursorX) / oldPps
    const timeAtCursorAfter = (newScrollLeft + cursorX) / newPps
    expect(timeAtCursorAfter).toBeCloseTo(timeAtCursorBefore, 5)
  })

  it('never returns a negative scroll offset', () => {
    expect(computeZoomAroundCursor(0, 0, 10, 2)).toBeGreaterThanOrEqual(0)
  })
})

describe('zoomToRange', () => {
  it('fits the given time range exactly into the viewport width', () => {
    const { pixelsPerSecond } = zoomToRange(10, 20, 500)
    expect(pixelsPerSecond).toBeCloseTo(50, 5) // 500px / 10s
  })

  it('scrolls so the range start is at the left edge', () => {
    const { pixelsPerSecond, scrollLeft } = zoomToRange(10, 20, 500)
    expect(scrollLeft).toBeCloseTo(10 * pixelsPerSecond, 5)
  })

  it('clamps the resulting zoom to [MIN_PPS, MAX_PPS]', () => {
    expect(zoomToRange(0, 100000, 500).pixelsPerSecond).toBe(MIN_PPS)
    expect(zoomToRange(0, 0.001, 500).pixelsPerSecond).toBe(MAX_PPS)
  })
})
