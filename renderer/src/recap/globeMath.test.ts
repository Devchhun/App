import { describe, expect, it } from 'vitest'
import { buildGlobeSamples, paintGlobe } from './globeMath'

describe('globe math', () => {
  it('covers the disc only, with a soft edge', () => {
    const samples = buildGlobeSamples(40)
    // Area of a radius-20 disc is ~1257 px; the anti-aliased rim adds a few.
    expect(samples.index.length).toBeGreaterThan(1200)
    expect(samples.index.length).toBeLessThan(1360)
    expect(Math.min(...samples.alpha)).toBeGreaterThan(0)
    expect(Math.max(...samples.alpha)).toBe(1)
  })

  it('looks at longitude 0 in the middle when untilted', () => {
    const samples = buildGlobeSamples(41, 0, 0)
    const center = 20 * 41 + 20
    const i = samples.index.indexOf(center)
    expect(samples.u[i]).toBeCloseTo(0.5, 2)
    expect(samples.v[i]).toBeCloseTo(0.5, 2)
  })

  it('slides the map as it turns', () => {
    const samples = buildGlobeSamples(8, 0, 0)
    const texture = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) }
    const a = new Uint8ClampedArray(8 * 8 * 4)
    const b = new Uint8ClampedArray(8 * 8 * 4)
    paintGlobe(samples, texture, 0, a)
    paintGlobe(samples, texture, 0.5, b)
    const o = samples.index[Math.floor(samples.index.length / 2)] * 4
    // Half a turn swaps which half of the map is in front.
    expect(Math.sign(a[o] - a[o + 2])).toBe(-Math.sign(b[o] - b[o + 2]))
  })
})
