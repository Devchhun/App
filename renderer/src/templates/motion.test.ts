import { describe, it, expect } from 'vitest'
import {
  computeTemplateMotionFrame,
  resolveMotionOptions,
  getMotionPresetDefaults,
  loopProgress,
  pulse,
  deterministicFloat,
  deterministicRotation,
  easeOut,
  easeInOut,
  getStaggeredItemProgress
} from './motion'

const TECHNICAL = getMotionPresetDefaults('technical')

describe('computeTemplateMotionFrame', () => {
  it('is an exact deterministic function of its inputs -- same timestamp always produces the same frame', () => {
    const a = computeTemplateMotionFrame(2.37, 1, 6, TECHNICAL)
    const b = computeTemplateMotionFrame(2.37, 1, 6, TECHNICAL)
    expect(a).toEqual(b)
  })

  it('computes localTime as currentTime - startTime', () => {
    const frame = computeTemplateMotionFrame(3.5, 1, 6, TECHNICAL)
    expect(frame.localTime).toBeCloseTo(2.5, 10)
  })

  it('enter phase: enterProgress ramps 0 -> 1 across [0, enterDuration]', () => {
    const opts = { ...TECHNICAL, enterDuration: 0.5, exitDuration: 0.4 }
    expect(computeTemplateMotionFrame(1, 1, 6, opts).enterProgress).toBe(0)
    expect(computeTemplateMotionFrame(1.25, 1, 6, opts).enterProgress).toBeCloseTo(0.5, 5)
    expect(computeTemplateMotionFrame(1.5, 1, 6, opts).enterProgress).toBe(1)
    expect(computeTemplateMotionFrame(3, 1, 6, opts).enterProgress).toBe(1) // stays 1 through hold
  })

  it('hold phase: holdProgress ramps across [enterDuration, duration - exitDuration]', () => {
    const opts = { ...TECHNICAL, enterDuration: 0.5, exitDuration: 0.5 }
    const frame = computeTemplateMotionFrame(1, 1, 6, opts) // duration 5, hold window [0.5, 4.5] local
    expect(frame.holdProgress).toBe(0)
    const mid = computeTemplateMotionFrame(1 + 2.5, 1, 6, opts)
    expect(mid.holdProgress).toBeCloseTo(0.5, 5)
  })

  it('holdTime is 0 until the hold phase begins, then grows unclamped through hold and exit', () => {
    const opts = { ...TECHNICAL, enterDuration: 0.5, exitDuration: 0.5 }
    expect(computeTemplateMotionFrame(1, 1, 6, opts).holdTime).toBe(0)
    expect(computeTemplateMotionFrame(1.2, 1, 6, opts).holdTime).toBe(0) // still in enter
    expect(computeTemplateMotionFrame(1.5, 1, 6, opts).holdTime).toBeCloseTo(0, 10) // hold just started
    expect(computeTemplateMotionFrame(3, 1, 6, opts).holdTime).toBeCloseTo(1.5, 10) // localTime 2 - holdStart 0.5
    expect(computeTemplateMotionFrame(5.9, 1, 6, opts).holdTime).toBeCloseTo(4.4, 5) // still growing in exit
  })

  it('exit phase: exitProgress ramps 0 -> 1 across [duration - exitDuration, duration]', () => {
    const opts = { ...TECHNICAL, enterDuration: 0.5, exitDuration: 0.5 } // duration 5
    expect(computeTemplateMotionFrame(1 + 4.5, 1, 6, opts).exitProgress).toBe(0)
    expect(computeTemplateMotionFrame(1 + 4.75, 1, 6, opts).exitProgress).toBeCloseTo(0.5, 5)
    expect(computeTemplateMotionFrame(1 + 5, 1, 6, opts).exitProgress).toBe(1)
  })

  it('scrubbing backward produces the exact reverse of scrubbing forward at the same timestamps', () => {
    const times = [1.1, 1.6, 2.9, 4.2, 5.7]
    const forward = times.map((t) => computeTemplateMotionFrame(t, 1, 6, TECHNICAL))
    const backward = [...times].reverse().map((t) => computeTemplateMotionFrame(t, 1, 6, TECHNICAL))
    expect(backward.reverse()).toEqual(forward)
  })

  it('normalizes intensity from 0-100 to 0-1 and clamps out-of-range values', () => {
    expect(computeTemplateMotionFrame(2, 1, 6, { ...TECHNICAL, intensity: 50 }).intensity).toBeCloseTo(0.5, 5)
    expect(computeTemplateMotionFrame(2, 1, 6, { ...TECHNICAL, intensity: 500 }).intensity).toBe(1)
    expect(computeTemplateMotionFrame(2, 1, 6, { ...TECHNICAL, intensity: -20 }).intensity).toBe(0)
  })

  it('the "none" preset has near-zero intensity and loop disabled', () => {
    const none = getMotionPresetDefaults('none')
    const frame = computeTemplateMotionFrame(2, 1, 6, none)
    expect(frame.intensity).toBe(0)
    expect(frame.loopEnabled).toBe(false)
  })
})

describe('resolveMotionOptions', () => {
  it('uses the preset default when a scene has no explicit motionPreset', () => {
    const resolved = resolveMotionOptions({}, 'gentle')
    expect(resolved).toEqual(getMotionPresetDefaults('gentle'))
  })

  it('an explicit motionPreset overrides the template default', () => {
    const resolved = resolveMotionOptions({ motionPreset: 'dynamic' }, 'gentle')
    expect(resolved.preset).toBe('dynamic')
  })

  it('individual field overrides win over the preset, independently of each other', () => {
    const resolved = resolveMotionOptions({ motionPreset: 'technical', loopEnabled: false, motionIntensity: 12 }, 'gentle')
    expect(resolved.loopEnabled).toBe(false)
    expect(resolved.intensity).toBe(12)
    expect(resolved.loopSpeed).toBe(getMotionPresetDefaults('technical').loopSpeed) // untouched field still comes from the preset
  })

  it('intensity 0 (motion preset "none" equivalent) is respected exactly, not treated as "unset"', () => {
    const resolved = resolveMotionOptions({ motionIntensity: 0 }, 'technical')
    expect(resolved.intensity).toBe(0)
  })
})

describe('loopProgress', () => {
  it('wraps deterministically at the period boundary', () => {
    expect(loopProgress(0, 1, 2)).toBe(0)
    expect(loopProgress(1, 1, 2)).toBeCloseTo(0.5, 5)
    expect(loopProgress(2, 1, 2)).toBeCloseTo(0, 10) // exactly one full period -> wraps to 0
    expect(loopProgress(3, 1, 2)).toBeCloseTo(0.5, 5)
  })

  it('speed scales how fast the loop advances', () => {
    expect(loopProgress(1, 2, 2)).toBeCloseTo(0, 10) // 2x speed covers a full period in half the time
  })

  it('offset staggers multiple loops sharing a period', () => {
    const a = loopProgress(0, 1, 2, 0)
    const b = loopProgress(0, 1, 2, 0.5)
    expect(a).not.toBeCloseTo(b, 5)
  })

  it('never returns a negative or >=1 value for arbitrary holdTime', () => {
    for (const t of [-5, -0.3, 0, 0.7, 100.25]) {
      const p = loopProgress(t, 1.3, 1.7, 0.2)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })
})

describe('pulse', () => {
  it('stays within [min, max]', () => {
    for (let t = 0; t < 5; t += 0.1) {
      const v = pulse(t, 1, 0.6, 1)
      expect(v).toBeGreaterThanOrEqual(0.6 - 1e-9)
      expect(v).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('is deterministic and periodic', () => {
    expect(pulse(0, 1)).toBeCloseTo(pulse(1, 1), 5) // speed 1 -> period 1s
  })
})

describe('deterministicFloat / deterministicRotation', () => {
  it('float is bounded by amplitude and deterministic', () => {
    const v1 = deterministicFloat(1.234, 0.5, 10)
    const v2 = deterministicFloat(1.234, 0.5, 10)
    expect(v1).toBe(v2)
    expect(Math.abs(v1)).toBeLessThanOrEqual(10 + 1e-9)
  })

  it('rotation stays within [0, 360) and is deterministic', () => {
    for (const t of [0, 5, 123.456]) {
      const deg = deterministicRotation(t, 30)
      expect(deg).toBeGreaterThanOrEqual(0)
      expect(deg).toBeLessThan(360)
      expect(deg).toBe(deterministicRotation(t, 30))
    }
  })
})

describe('easing', () => {
  it('easeOut and easeInOut both map 0->0 and 1->1, clamped outside [0,1]', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(-1)).toBe(0)
    expect(easeOut(2)).toBe(1)
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
  })
})

describe('getStaggeredItemProgress', () => {
  it('1. staggerDelay 0 makes every item start together', () => {
    const p0 = getStaggeredItemProgress({ localTime: 1, phaseStart: 0, itemIndex: 0, itemCount: 4, staggerDelay: 0, enterDuration: 3, itemDuration: 2 })
    const p3 = getStaggeredItemProgress({ localTime: 1, phaseStart: 0, itemIndex: 3, itemCount: 4, staggerDelay: 0, enterDuration: 3, itemDuration: 2 })
    expect(p0).toBeCloseTo(p3, 10)
  })

  it('2. 0.1, 0.3, and 0.6 produce different item start times (and therefore different progress)', () => {
    const at = (staggerDelay: number) =>
      getStaggeredItemProgress({ localTime: 0.7, phaseStart: 0, itemIndex: 2, itemCount: 4, staggerDelay, enterDuration: 3, itemDuration: 2 })
    const p1 = at(0.1)
    const p3 = at(0.3)
    const p6 = at(0.6)
    expect(p1).not.toBeCloseTo(p3, 5)
    expect(p3).not.toBeCloseTo(p6, 5)
    expect(p1).toBeGreaterThan(p3) // a smaller delay means item 2 started earlier -> further along by the same localTime
    expect(p3).toBeGreaterThan(p6)
  })

  it('3. missing/undefined staggerDelay and itemDuration fall back to safe, finite defaults', () => {
    const p = getStaggeredItemProgress({
      localTime: 0.5,
      phaseStart: 0,
      itemIndex: 2,
      itemCount: 4,
      staggerDelay: undefined as unknown as number,
      enterDuration: 1
    })
    expect(Number.isFinite(p)).toBe(true)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
  })

  it('4. negative/invalid staggerDelay, itemCount, and itemIndex are normalized instead of propagating NaN/negative timing', () => {
    const p = getStaggeredItemProgress({
      localTime: 5,
      phaseStart: 0,
      itemIndex: -1,
      itemCount: -3,
      staggerDelay: -5,
      enterDuration: 1,
      itemDuration: 0.5
    })
    // itemCount clamps to 1, itemIndex clamps to 0, staggerDelay clamps to 0 --
    // a single item starting at phaseStart, fully revealed well before localTime 5.
    expect(p).toBe(1)
  })

  it('5. an excessively large staggerDelay is capped rather than producing runaway/never-arriving timing', () => {
    const stillWaiting = getStaggeredItemProgress({ localTime: 4.99, phaseStart: 0, itemIndex: 1, itemCount: 2, staggerDelay: 999999, enterDuration: 1, itemDuration: 0.5 })
    expect(stillWaiting).toBe(0)
    const justStarted = getStaggeredItemProgress({ localTime: 5.01, phaseStart: 0, itemIndex: 1, itemCount: 2, staggerDelay: 999999, enterDuration: 1, itemDuration: 0.5 })
    expect(justStarted).toBeGreaterThan(0)
    expect(justStarted).toBeLessThan(1)
  })

  it('6. seeking to the same timestamp twice produces identical progress', () => {
    const input = {
      localTime: 1.234,
      phaseStart: 0.1,
      itemIndex: 2,
      itemCount: 5,
      staggerDelay: 0.15,
      enterDuration: 1.5,
      itemDuration: 0.4,
      intensity: 0.7,
      easing: 'ease-in-out' as const
    }
    expect(getStaggeredItemProgress(input)).toBe(getStaggeredItemProgress(input))
  })

  it('7. motion preset "none" resolves staggerDelay to 0, producing no staggered animation', () => {
    const noneOptions = getMotionPresetDefaults('none')
    expect(noneOptions.staggerDelay).toBe(0)
    const first = getStaggeredItemProgress({ localTime: 0.005, phaseStart: 0, itemIndex: 0, itemCount: 3, staggerDelay: noneOptions.staggerDelay, enterDuration: noneOptions.enterDuration })
    const last = getStaggeredItemProgress({ localTime: 0.005, phaseStart: 0, itemIndex: 2, itemCount: 3, staggerDelay: noneOptions.staggerDelay, enterDuration: noneOptions.enterDuration })
    expect(first).toBe(last)
  })

  it('handles itemCount 0 and 1 safely', () => {
    const zeroItems = getStaggeredItemProgress({ localTime: 1, phaseStart: 0, itemIndex: 0, itemCount: 0, staggerDelay: 0.1, enterDuration: 1, itemDuration: 0.3 })
    expect(Number.isFinite(zeroItems)).toBe(true)
    const singleItem = getStaggeredItemProgress({ localTime: 1, phaseStart: 0, itemIndex: 0, itemCount: 1, staggerDelay: 0.1, enterDuration: 1, itemDuration: 0.3 })
    expect(singleItem).toBe(1)
  })

  it('respects the requested easing curve', () => {
    const linear = getStaggeredItemProgress({ localTime: 0.5, phaseStart: 0, itemIndex: 0, itemCount: 1, staggerDelay: 0, enterDuration: 1, itemDuration: 1, easing: 'linear' })
    const easedOut = getStaggeredItemProgress({ localTime: 0.5, phaseStart: 0, itemIndex: 0, itemCount: 1, staggerDelay: 0, enterDuration: 1, itemDuration: 1, easing: 'ease-out' })
    expect(linear).toBeCloseTo(0.5, 10)
    expect(easedOut).toBeCloseTo(0.75, 10)
  })

  it('higher motion intensity makes an item reach completion sooner', () => {
    const lowIntensity = getStaggeredItemProgress({ localTime: 0.3, phaseStart: 0, itemIndex: 0, itemCount: 1, staggerDelay: 0, enterDuration: 1, itemDuration: 0.5, intensity: 0 })
    const highIntensity = getStaggeredItemProgress({ localTime: 0.3, phaseStart: 0, itemIndex: 0, itemCount: 1, staggerDelay: 0, enterDuration: 1, itemDuration: 0.5, intensity: 1 })
    expect(highIntensity).toBeGreaterThan(lowIntensity)
  })

  it('always returns a clamped 0-1 value regardless of how far before/after the item window localTime is', () => {
    const before = getStaggeredItemProgress({ localTime: -10, phaseStart: 0, itemIndex: 0, itemCount: 3, staggerDelay: 0.1, enterDuration: 1, itemDuration: 0.3 })
    const after = getStaggeredItemProgress({ localTime: 500, phaseStart: 0, itemIndex: 2, itemCount: 3, staggerDelay: 0.1, enterDuration: 1, itemDuration: 0.3 })
    expect(before).toBe(0)
    expect(after).toBe(1)
  })
})
