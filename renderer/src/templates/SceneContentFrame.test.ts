import { describe, it, expect } from 'vitest'
import { computeContentFrameScale } from './SceneContentFrame'
import { INTRINSIC_SIZE, INTRINSIC_SIZE_COMPACT } from './CauseEffectFlow'
import { getDefaultContentTransform } from '../scenes/contentTransformReflow'
import { CANVAS_SIZE_BY_ASPECT } from '@shared/templates'
import type { SceneContentTransform } from '@shared/templates'

describe('computeContentFrameScale', () => {
  it('unlocked: scaleX/scaleY are independently contentSize / intrinsicSize', () => {
    const scale = computeContentFrameScale({ widthPercent: 50, heightPercent: 50, lockAspectRatio: false }, '1:1', 500, 250)
    // 1:1 canvas is 1080x1080 (see CANVAS_SIZE_BY_ASPECT) -> 50% = 540px.
    expect(scale.contentWidthPx).toBeCloseTo(540, 5)
    expect(scale.contentHeightPx).toBeCloseTo(540, 5)
    expect(scale.scaleX).toBeCloseTo(540 / 500, 5)
    expect(scale.scaleY).toBeCloseTo(540 / 250, 5)
    expect(scale.scaleX).not.toBeCloseTo(scale.scaleY, 2)
  })

  it('locked: scaleX equals scaleY (uniform), using the smaller of the two raw scales', () => {
    const scale = computeContentFrameScale({ widthPercent: 50, heightPercent: 25, lockAspectRatio: true }, '1:1', 500, 250)
    expect(scale.scaleX).toBe(scale.scaleY)
    // width would want scale 540/500=1.08, height wants 270/250=1.08 -- here
    // they happen to match; use an asymmetric case to prove it takes the min.
    const asymmetric = computeContentFrameScale({ widthPercent: 80, heightPercent: 20, lockAspectRatio: true }, '1:1', 500, 250)
    const rawScaleX = (0.8 * 1080) / 500
    const rawScaleY = (0.2 * 1080) / 250
    expect(asymmetric.scaleX).toBeCloseTo(Math.min(rawScaleX, rawScaleY), 5)
  })

  it('never produces a non-finite or negative scale for degenerate inputs', () => {
    const scale = computeContentFrameScale({ widthPercent: 0, heightPercent: 0, lockAspectRatio: false }, '16:9', 0, 0)
    expect(Number.isFinite(scale.scaleX)).toBe(true)
    expect(Number.isFinite(scale.scaleY)).toBe(true)
    expect(scale.scaleX).toBeGreaterThan(0)
    expect(scale.scaleY).toBeGreaterThan(0)
  })

  describe('8. Cause and Effect Flow stays inside its declared root content box', () => {
    // The whole point of SceneContentFrame: the inner composition is scaled
    // to fit EXACTLY inside contentWidthPx x contentHeightPx (unlocked) or
    // strictly within it (locked, uniform scale) -- never larger. As long as
    // that holds for CauseEffectFlow's own intrinsic size at any transform a
    // user could reach via drag/resize, the cause card, connector, effect
    // card, and supporting items -- all authored relative to that intrinsic
    // box in CauseEffectFlow.tsx/styles.css, with no negative offsets -- can
    // never render outside the selection rectangle.
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      it(`holds for the ${aspect} default transform, non-compact intrinsic size`, () => {
        const transform = getDefaultContentTransform('cause-effect-flow', aspect)!
        const scale = computeContentFrameScale(transform, aspect, INTRINSIC_SIZE.width, INTRINSIC_SIZE.height)
        expect(INTRINSIC_SIZE.width * scale.scaleX).toBeLessThanOrEqual(scale.contentWidthPx + 1e-6)
        expect(INTRINSIC_SIZE.height * scale.scaleY).toBeLessThanOrEqual(scale.contentHeightPx + 1e-6)
      })

      it(`holds for the ${aspect} default transform, compact intrinsic size`, () => {
        const transform = getDefaultContentTransform('cause-effect-flow', aspect)!
        const scale = computeContentFrameScale(transform, aspect, INTRINSIC_SIZE_COMPACT.width, INTRINSIC_SIZE_COMPACT.height)
        expect(INTRINSIC_SIZE_COMPACT.width * scale.scaleX).toBeLessThanOrEqual(scale.contentWidthPx + 1e-6)
        expect(INTRINSIC_SIZE_COMPACT.height * scale.scaleY).toBeLessThanOrEqual(scale.contentHeightPx + 1e-6)
      })
    }

    it('holds across a range of user-resized boxes, locked and unlocked', () => {
      const sizes: Array<Pick<SceneContentTransform, 'widthPercent' | 'heightPercent' | 'lockAspectRatio'>> = [
        { widthPercent: 20, heightPercent: 15, lockAspectRatio: false },
        { widthPercent: 90, heightPercent: 88, lockAspectRatio: false },
        { widthPercent: 45, heightPercent: 70, lockAspectRatio: true },
        { widthPercent: 92, heightPercent: 10, lockAspectRatio: true }
      ]
      for (const size of sizes) {
        const scale = computeContentFrameScale(size, '16:9', INTRINSIC_SIZE.width, INTRINSIC_SIZE.height)
        expect(INTRINSIC_SIZE.width * scale.scaleX).toBeLessThanOrEqual(scale.contentWidthPx + 1e-6)
        expect(INTRINSIC_SIZE.height * scale.scaleY).toBeLessThanOrEqual(scale.contentHeightPx + 1e-6)
      }
    })
  })
})

describe('CANVAS_SIZE_BY_ASPECT sanity (used by the scale math above)', () => {
  it('1:1 is a square canvas', () => {
    expect(CANVAS_SIZE_BY_ASPECT['1:1'].width).toBe(CANVAS_SIZE_BY_ASPECT['1:1'].height)
  })
})
