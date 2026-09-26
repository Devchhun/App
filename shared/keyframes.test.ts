import { describe, expect, it } from 'vitest'
import { interpolateKeyframes, isAnimated, type ClipKeyframe } from './keyframes'

function kf(time: number, value: number, easing?: ClipKeyframe['easing']): ClipKeyframe {
  return { id: `kf-${time}-${value}`, time, value, easing }
}

describe('interpolateKeyframes', () => {
  it('returns the fallback unchanged when there are no keyframes at all', () => {
    expect(interpolateKeyframes(undefined, 5, 42)).toBe(42)
    expect(interpolateKeyframes([], 5, 42)).toBe(42)
  })

  it('returns a single keyframe\'s value as a constant regardless of time', () => {
    const keyframes = [kf(3, 10)]
    expect(interpolateKeyframes(keyframes, 0, 0)).toBe(10)
    expect(interpolateKeyframes(keyframes, 3, 0)).toBe(10)
    expect(interpolateKeyframes(keyframes, 999, 0)).toBe(10)
  })

  it('linearly interpolates between two bracketing keyframes', () => {
    const keyframes = [kf(0, 0), kf(10, 100)]
    expect(interpolateKeyframes(keyframes, 5, 0)).toBe(50)
    expect(interpolateKeyframes(keyframes, 2.5, 0)).toBe(25)
  })

  it('clamps flat to the first keyframe before the range, and the last keyframe after it -- never extrapolates', () => {
    const keyframes = [kf(5, 20), kf(10, 80)]
    expect(interpolateKeyframes(keyframes, 0, 999)).toBe(20)
    expect(interpolateKeyframes(keyframes, 100, 999)).toBe(80)
  })

  it('picks the correct segment among 3+ keyframes', () => {
    const keyframes = [kf(0, 0), kf(5, 50), kf(10, 0)]
    expect(interpolateKeyframes(keyframes, 2.5, -1)).toBe(25)
    expect(interpolateKeyframes(keyframes, 7.5, -1)).toBe(25)
    expect(interpolateKeyframes(keyframes, 5, -1)).toBe(50)
  })

  it('does not require keyframes to be given in time order', () => {
    const keyframes = [kf(10, 100), kf(0, 0)]
    expect(interpolateKeyframes(keyframes, 5, -1)).toBe(50)
  })

  it('ease-in eases the segment leading into the LATER keyframe (slow start, matches quadratic easing)', () => {
    const keyframes = [kf(0, 0), kf(10, 100, 'ease-in')]
    const atQuarter = interpolateKeyframes(keyframes, 2.5, -1) // rawT = 0.25, eased = 0.0625
    expect(atQuarter).toBeCloseTo(6.25, 5)
  })

  it('ease-out reaches the target value faster than linear (bows the other way)', () => {
    const keyframes = [kf(0, 0), kf(10, 100, 'ease-out')]
    const atQuarter = interpolateKeyframes(keyframes, 2.5, -1) // rawT = 0.25, eased = 1-(0.75)^2 = 0.4375
    expect(atQuarter).toBeCloseTo(43.75, 5)
  })

  it('ease-in-out is symmetric around the midpoint', () => {
    const keyframes = [kf(0, 0), kf(10, 100, 'ease-in-out')]
    expect(interpolateKeyframes(keyframes, 5, -1)).toBeCloseTo(50, 5)
  })

  it('an undefined easing behaves as linear', () => {
    const keyframes = [kf(0, 0), kf(10, 100)]
    expect(interpolateKeyframes(keyframes, 5, -1)).toBe(50)
  })

  it('exact boundary times return the exact keyframe value with no floating-point drift', () => {
    const keyframes = [kf(0, 0), kf(3.3, 17), kf(10, 100)]
    expect(interpolateKeyframes(keyframes, 3.3, -1)).toBe(17)
  })
})

describe('isAnimated', () => {
  it('is false for 0 or 1 keyframes (a constant, not an animation)', () => {
    expect(isAnimated(undefined)).toBe(false)
    expect(isAnimated([])).toBe(false)
    expect(isAnimated([kf(0, 5)])).toBe(false)
  })

  it('is true for 2 or more keyframes', () => {
    expect(isAnimated([kf(0, 0), kf(5, 10)])).toBe(true)
  })
})
