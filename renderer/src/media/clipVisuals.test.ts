import { describe, expect, it } from 'vitest'
import type { TimelineClip } from '@shared/project'
import { clipHasAnimatedProperties, computeClipVisualStyle, resolveClipVolume } from './clipVisuals'

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return { id: 'c1', mediaId: 'm1', type: 'video', trackId: 'V1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false, ...overrides }
}

describe('computeClipVisualStyle', () => {
  it('returns an empty style for a plain clip with no opacity/transform/keyframes at all (today\'s exact behavior)', () => {
    expect(computeClipVisualStyle(clip(), 5)).toEqual({})
  })

  it('returns an empty style for undefined clip', () => {
    expect(computeClipVisualStyle(undefined, 5)).toEqual({})
  })

  it('applies a static opacity unchanged when there are no opacity keyframes', () => {
    expect(computeClipVisualStyle(clip({ opacity: 0.5 }), 5)).toEqual({ opacity: 0.5 })
  })

  it('applies a static transform unchanged when there are no transform keyframes', () => {
    const style = computeClipVisualStyle(clip({ transform: { x: 10, y: -5, scaleX: 2, scaleY: 2, rotation: 45, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 } }), 5)
    expect(style.transform).toBe('translate(10px, -5px) scale(2, 2) rotate(45deg)')
    expect(style.clipPath).toBeUndefined()
  })

  it('applies a static crop as a clipPath unchanged when there are no crop keyframes', () => {
    const style = computeClipVisualStyle(clip({ transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0.1, cropRight: 0, cropBottom: 0, cropLeft: 0 } }), 5)
    expect(style.clipPath).toBe('inset(10% 0% 0% 0%)')
  })

  it('interpolates a keyframed opacity at the given time', () => {
    const c = clip({ keyframes: { opacity: [{ id: 'k1', time: 0, value: 0 }, { id: 'k2', time: 10, value: 1 }] } })
    expect(computeClipVisualStyle(c, 5).opacity).toBe(0.5)
  })

  it('interpolates keyframed position/scale/rotation independently of the static transform fallback', () => {
    const c = clip({
      transform: { x: 999, y: 999, scaleX: 999, scaleY: 999, rotation: 999, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
      keyframes: {
        x: [{ id: 'k1', time: 0, value: 0 }, { id: 'k2', time: 10, value: 100 }],
        rotation: [{ id: 'k3', time: 0, value: 0 }, { id: 'k4', time: 10, value: 90 }]
      }
    })
    const style = computeClipVisualStyle(c, 5)
    expect(style.transform).toBe('translate(50px, 999px) scale(999, 999) rotate(45deg)')
  })

  it('a clip with keyframes but no static transform still gets a transform style (hasTransform triggers on keyframes alone)', () => {
    const c = clip({ keyframes: { scaleX: [{ id: 'k1', time: 0, value: 1 }, { id: 'k2', time: 10, value: 2 }] } })
    const style = computeClipVisualStyle(c, 0)
    expect(style.transform).toBe('translate(0px, 0px) scale(1, 1) rotate(0deg)')
  })
})

describe('resolveClipVolume', () => {
  it('returns 1 (full volume) for a plain clip with no volume set and no keyframes', () => {
    expect(resolveClipVolume(clip(), 5)).toBe(1)
  })

  it('returns the static volume unchanged when there are no volume keyframes', () => {
    expect(resolveClipVolume(clip({ volume: 0.3 }), 5)).toBe(0.3)
  })

  it('interpolates a keyframed volume at the given time', () => {
    const c = clip({ keyframes: { volume: [{ id: 'k1', time: 0, value: 1 }, { id: 'k2', time: 10, value: 0 }] } })
    expect(resolveClipVolume(c, 5)).toBe(0.5)
  })

  it('returns 1 for undefined clip', () => {
    expect(resolveClipVolume(undefined, 5)).toBe(1)
  })
})

describe('clipHasAnimatedProperties', () => {
  it('is false for undefined clip, a clip with no keyframes field, and a clip with only single (non-animating) keyframes', () => {
    expect(clipHasAnimatedProperties(undefined)).toBe(false)
    expect(clipHasAnimatedProperties(clip())).toBe(false)
    expect(clipHasAnimatedProperties(clip({ keyframes: { opacity: [{ id: 'k1', time: 0, value: 1 }] } }))).toBe(false)
  })

  it('is true when any property has 2+ keyframes', () => {
    const c = clip({ keyframes: { volume: [{ id: 'k1', time: 0, value: 1 }, { id: 'k2', time: 5, value: 0 }] } })
    expect(clipHasAnimatedProperties(c)).toBe(true)
  })
})
