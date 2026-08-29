import { describe, it, expect } from 'vitest'
import { playheadBadgeEdge } from './playheadBadgePosition'

describe('playheadBadgeEdge', () => {
  it('is null in the middle of the visible viewport', () => {
    expect(playheadBadgeEdge(500, 0, 1000)).toBeNull()
  })

  it('is "left" at time 0 (the most common case -- always a ruler tick)', () => {
    expect(playheadBadgeEdge(0, 0, 1000)).toBe('left')
  })

  it('is "left" whenever within the left threshold of the visible start, even mid-project', () => {
    expect(playheadBadgeEdge(620, 600, 1600)).toBe('left')
  })

  it('is "right" near the visible right edge', () => {
    expect(playheadBadgeEdge(990, 0, 1000)).toBe('right')
  })

  it('prefers "left" when the viewport is too narrow to be not-near-either-edge', () => {
    // A pathologically narrow viewport where both thresholds overlap --
    // left is checked first, so it wins rather than being ambiguous.
    expect(playheadBadgeEdge(10, 0, 50)).toBe('left')
  })
})
