import { describe, expect, it } from 'vitest'
import { nextPlaybackScrollLeft } from './playbackFollow'

describe('nextPlaybackScrollLeft', () => {
  it('does not scroll while the playhead is inside the forward guide', () => {
    expect(nextPlaybackScrollLeft(500, 100, 800)).toBe(100)
  })

  it('eases instead of jumping a whole page at the right edge', () => {
    const next = nextPlaybackScrollLeft(900, 100, 800)
    expect(next).toBeGreaterThan(100)
    expect(next).toBeLessThan(324)
  })

  it('brings a playhead left of the viewport back into view', () => {
    expect(nextPlaybackScrollLeft(100, 500, 800)).toBeLessThan(500)
  })
})
