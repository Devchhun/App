import { describe, expect, it } from 'vitest'
import { positionScale, POSITION_REFERENCE_SHORT_SIDE } from './clipPosition'

describe('positionScale', () => {
  it('is 1 at the reference size (1080 on the short side)', () => {
    expect(POSITION_REFERENCE_SHORT_SIDE).toBe(1080)
    expect(positionScale({ width: 1920, height: 1080 })).toBe(1)
    expect(positionScale({ width: 1080, height: 1920 })).toBe(1)
  })

  it('scales with the frame, so the Player and every export size agree', () => {
    // The same Position, as a fraction of the frame, everywhere.
    const fraction = (w: number, h: number): number => (100 * positionScale({ width: w, height: h })) / w
    expect(fraction(660, 371.25)).toBeCloseTo(fraction(1920, 1080), 6)
    expect(fraction(3840, 2160)).toBeCloseTo(fraction(854, 480.375), 6)
    expect(positionScale({ width: 3840, height: 2160 })).toBe(2)
  })
})
