import { describe, it, expect } from 'vitest'
import { isSceneVisibleAt } from './GraphicsOverlay'

describe('isSceneVisibleAt', () => {
  it('is visible exactly on [startTime, endTime)', () => {
    expect(isSceneVisibleAt(1, { startTime: 1, endTime: 3 })).toBe(true)
    expect(isSceneVisibleAt(2.999, { startTime: 1, endTime: 3 })).toBe(true)
    expect(isSceneVisibleAt(3, { startTime: 1, endTime: 3 })).toBe(false) // end is exclusive
  })

  it('is not visible before startTime', () => {
    expect(isSceneVisibleAt(0.99, { startTime: 1, endTime: 3 })).toBe(false)
  })

  it('is not visible for a selected scene sitting far outside the playhead -- selection alone must never force visibility', () => {
    // This is the exact bug from the screenshot: a scene near the start of the
    // timeline stayed visible while the playhead was at 00:42. isSceneVisibleAt
    // takes no selection state at all, so there is no way for it to leak in.
    expect(isSceneVisibleAt(42, { startTime: 0, endTime: 3 })).toBe(false)
  })

  it('handles a zero-duration or inverted range without throwing and without ever reporting visible', () => {
    expect(isSceneVisibleAt(1, { startTime: 1, endTime: 1 })).toBe(false)
    expect(isSceneVisibleAt(1, { startTime: 2, endTime: 1 })).toBe(false)
  })
})
