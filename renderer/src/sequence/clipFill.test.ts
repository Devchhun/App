import { describe, expect, it } from 'vitest'
import { clipFillScale } from './clipFill'

describe('clipFillScale', () => {
  it('scales a picture of another shape up until it covers the frame', () => {
    expect(clipFillScale({ width: 1080, height: 1920 }, '16:9')).toBeCloseTo(3.16, 2) // vertical drama in 16:9
    expect(clipFillScale({ width: 2598, height: 1080 }, '16:9')).toBeCloseTo(1.353, 3) // wide film in 16:9
    expect(clipFillScale({ width: 1920, height: 1080 }, '9:16')).toBeCloseTo(3.16, 2)
  })
  it('is 1 when the shapes already match, and unknown without a size', () => {
    expect(clipFillScale({ width: 1920, height: 1080 }, '16:9')).toBe(1)
    expect(clipFillScale(undefined, '16:9')).toBeNull()
  })
})
