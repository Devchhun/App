import { describe, expect, it } from 'vitest'
import { frameTime, frameDuration, DEFAULT_FPS } from './frameMath'

describe('frameTime', () => {
  it('snaps to the nearest exact frame at the given fps', () => {
    expect(frameTime(1.001, 30)).toBeCloseTo(1, 5)
    expect(frameTime(1.02, 30)).toBeCloseTo(1 + 1 / 30, 5)
  })
  it('defaults to 30fps when no fps is given', () => {
    expect(frameTime(1.001)).toBeCloseTo(frameTime(1.001, DEFAULT_FPS), 10)
  })
  it('falls back to returning the input unchanged for invalid fps', () => {
    expect(frameTime(1.234, 0)).toBe(1.234)
    expect(frameTime(1.234, NaN)).toBe(1.234)
  })
})

describe('frameDuration', () => {
  it('is 1/fps', () => {
    expect(frameDuration(30)).toBeCloseTo(1 / 30, 10)
    expect(frameDuration(24)).toBeCloseTo(1 / 24, 10)
  })
  it('falls back to 1/DEFAULT_FPS for invalid fps', () => {
    expect(frameDuration(0)).toBeCloseTo(1 / DEFAULT_FPS, 10)
  })
})
