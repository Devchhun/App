import { describe, it, expect } from 'vitest'
import { pickTickInterval, computeRulerTicks } from './rulerTicks'

describe('pickTickInterval', () => {
  it('picks the smallest interval that keeps labels at least 70px apart', () => {
    expect(pickTickInterval(20)).toBe(5)
    expect(pickTickInterval(100)).toBe(1)
    expect(pickTickInterval(1)).toBe(120)
  })
})

describe('computeRulerTicks', () => {
  it('never produces a tick past the ruler duration when rangeEnd is capped by duration', () => {
    // Reproduces the real bug: a 12s clip padded to ~17s of visible timeline
    // at 20px/s (interval 5s) used to render a "00:20" tick floating past
    // the ruler's own 17s-wide CSS box.
    const duration = 17
    const { majorTicks, minorTicks } = computeRulerTicks(duration, 20, 0, duration)
    expect(Math.max(...majorTicks)).toBeLessThanOrEqual(duration)
    expect(Math.max(...minorTicks)).toBeLessThanOrEqual(duration)
    expect(majorTicks).toEqual([0, 5, 10, 15])
  })

  it('still renders one tick past the visible edge when capped by viewEnd, not duration', () => {
    // Scrolled to a partial view mid-timeline -- the smooth-scroll
    // "render one extra tick past the edge" behavior should still apply
    // since the real ruler extends well beyond this visible window.
    const duration = 1000
    const { majorTicks } = computeRulerTicks(duration, 20, 40, 57)
    expect(majorTicks).toContain(60)
  })

  it('excludes minor ticks that land exactly on a major tick', () => {
    const { majorTicks, minorTicks } = computeRulerTicks(20, 20, 0, 20)
    for (const t of minorTicks) expect(majorTicks).not.toContain(t)
  })
})
