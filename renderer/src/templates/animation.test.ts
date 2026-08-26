import { describe, it, expect } from 'vitest'
import { clampInterpolate, computeSceneMotion, remap, stagger } from './animation'

describe('clampInterpolate', () => {
  it('clamps below and above the input range', () => {
    expect(clampInterpolate(-1, [0, 1], [0, 100])).toBe(0)
    expect(clampInterpolate(2, [0, 1], [0, 100])).toBe(100)
  })

  it('interpolates linearly within range', () => {
    expect(clampInterpolate(0.5, [0, 1], [0, 100])).toBe(50)
  })
})

describe('computeSceneMotion', () => {
  it('is invisible before startTime and at/after endTime', () => {
    expect(computeSceneMotion(0.5, 1, 3).visible).toBe(false)
    expect(computeSceneMotion(3, 1, 3).visible).toBe(false)
  })

  it('fades in at the start and out at the end, fully opaque during the hold', () => {
    const start = computeSceneMotion(1.0, 1, 3)
    expect(start.visible).toBe(true)
    expect(start.opacity).toBeCloseTo(0, 5)

    const mid = computeSceneMotion(2.0, 1, 3)
    expect(mid.opacity).toBeCloseTo(1, 5)

    const nearEnd = computeSceneMotion(2.99, 1, 3)
    expect(nearEnd.opacity).toBeLessThan(0.2)
  })

  it('never exceeds an opacity of 1', () => {
    for (let t = 1; t < 3; t += 0.1) {
      expect(computeSceneMotion(t, 1, 3).opacity).toBeLessThanOrEqual(1)
    }
  })

  it('is a pure function of scene time -- identical inputs always produce identical output (seek-repeatable)', () => {
    const a = computeSceneMotion(1.7, 1, 3, { intensity: 'cinematic', easing: 'ease-in-out' })
    const b = computeSceneMotion(1.7, 1, 3, { intensity: 'cinematic', easing: 'ease-in-out' })
    expect(a).toEqual(b)
  })
})

describe('remap', () => {
  it('clamps to 0 before the window and 1 after it', () => {
    expect(remap(-0.5, 0, 1)).toBe(0)
    expect(remap(1.5, 0, 1)).toBe(1)
  })

  it('interpolates linearly inside an arbitrary window', () => {
    expect(remap(0.3, 0.2, 0.6)).toBeCloseTo(0.25, 5)
  })

  it('treats a zero-width window as a step function', () => {
    expect(remap(0.5, 0.5, 0.5)).toBe(1)
    expect(remap(0.4, 0.5, 0.5)).toBe(0)
  })
})

describe('stagger', () => {
  it('staggers items sequentially across the full 0-1 progress range', () => {
    expect(stagger(0, 0, 3)).toBe(0)
    expect(stagger(1 / 3, 0, 3)).toBeCloseTo(1, 5)
    expect(stagger(1 / 3, 1, 3)).toBe(0)
    expect(stagger(1, 2, 3)).toBeCloseTo(1, 5)
  })

  it('clamps within 0 and 1', () => {
    expect(stagger(0, 1, 3)).toBe(0)
    expect(stagger(1, 0, 3)).toBe(1)
  })

  it('falls back to the raw progress when count is 0', () => {
    expect(stagger(0.42, 0, 0)).toBe(0.42)
  })
})
