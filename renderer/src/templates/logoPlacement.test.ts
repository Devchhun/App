import { describe, expect, it } from 'vitest'
import { logoCornerTransform } from './logoPlacement'

describe('logoCornerTransform', () => {
  it('puts a wide logo small in the top-right corner of a 16:9 frame', () => {
    // The WorldMerl logo, 948 x 224.
    const t = logoCornerTransform({ width: 948, height: 224 }, '16:9')
    expect(t.scaleX).toBeCloseTo(0.2, 6) // fitted to the frame's width, then a fifth of it
    expect(t.scaleY).toBe(t.scaleX)
    const w = 1920 * 0.2
    const h = (w * 224) / 948
    // Right edge and top edge 43.2 units (4% of 1080) inside the frame.
    expect(t.x + w / 2).toBeCloseTo(960 - 43.2, 6)
    expect(t.y - h / 2).toBeCloseTo(-540 + 43.2, 6)
  })

  it('makes it wider in a 9:16 frame, still in its corner', () => {
    const t = logoCornerTransform({ width: 948, height: 224 }, '9:16')
    const w = 1080 * 0.42
    expect(t.x + w / 2).toBeCloseTo(540 - 43.2, 6)
  })
})
