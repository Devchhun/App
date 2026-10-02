import { describe, expect, it } from 'vitest'
import { findSubtitleBand, pickSampleTimes } from './subtitleDetect'

const W = 160
const H = 90

/** A noisy dark scene, a fixed logo top-left, and (optionally) a line of
 * bright "text" strokes at rows 74-79 whose columns change frame to frame. */
function frame(seed: number, withText = true): Uint8Array {
  const f = new Uint8Array(W * H)
  let r = seed * 9301 + 49297
  const rand = (): number => ((r = (r * 9301 + 49297) % 233280) / 233280)
  for (let i = 0; i < f.length; i++) f[i] = 30 + Math.floor(rand() * 40)
  for (let y = 5; y < 12; y++) for (let x = 5; x < 25; x++) f[y * W + x] = x % 3 === 0 ? 250 : 20 // logo
  if (withText) {
    const start = 40 + (seed % 5) * 3
    const end = 120 - (seed % 4) * 4
    for (let y = 74; y < 80; y++) for (let x = start; x < end; x++) if ((x + seed) % 4 < 2) f[y * W + x] = 240
  }
  return f
}

describe('findSubtitleBand', () => {
  it('finds the line of changing text near the bottom and ignores the fixed logo', () => {
    const band = findSubtitleBand(Array.from({ length: 12 }, (_, i) => frame(i + 1)), W, H)!
    expect(band).not.toBeNull()
    expect(band.y).toBeLessThan(74 / H)
    expect(band.y + band.h).toBeGreaterThan(80 / H)
    expect(band.y).toBeGreaterThan(0.6)
    expect(band.x).toBeLessThan(45 / W)
    expect(band.x + band.w).toBeGreaterThan(110 / W)
  })

  it('nothing when there is no text', () => {
    expect(findSubtitleBand(Array.from({ length: 8 }, (_, i) => frame(i + 1, false)), W, H)).toBeNull()
  })
})

describe('pickSampleTimes', () => {
  it('spreads the samples across all lines', () => {
    const times = pickSampleTimes(Array.from({ length: 100 }, (_, i) => i), 10)
    expect(times).toHaveLength(10)
    expect(times[0]).toBeLessThan(10)
    expect(times[9]).toBeGreaterThan(90)
  })
})
