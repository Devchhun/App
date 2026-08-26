import { describe, it, expect } from 'vitest'
import { computeStageSize, PREVIEW_STAGE_MAX_WIDTH, PREVIEW_STAGE_MAX_HEIGHT } from './previewStageSize'

describe('computeStageSize', () => {
  it('contain-fits the aspect ratio inside the available space when it is under the cap', () => {
    const size = computeStageSize(800, 600, 16, 9)!
    expect(size.width).toBeLessThanOrEqual(800)
    expect(size.height).toBeLessThanOrEqual(600)
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1)
  })

  it('caps the stage at a comfortable maximum on a large/4K/ultrawide monitor instead of growing without bound', () => {
    // A huge available area (e.g. a 4K wrap) must not produce a huge stage.
    const size = computeStageSize(3800, 2100, 16, 9)!
    expect(size.width).toBeLessThanOrEqual(PREVIEW_STAGE_MAX_WIDTH)
    expect(size.height).toBeLessThanOrEqual(PREVIEW_STAGE_MAX_HEIGHT)
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1)
  })

  it('preserves the exact aspect ratio when capped, never distorting the video', () => {
    for (const [w, h] of [
      [16, 9],
      [9, 16],
      [1, 1]
    ] as const) {
      const size = computeStageSize(4000, 4000, w, h)!
      expect(size.width / size.height).toBeCloseTo(w / h, 2)
    }
  })

  it('returns null for degenerate inputs instead of NaN/Infinity geometry', () => {
    expect(computeStageSize(0, 600, 16, 9)).toBeNull()
    expect(computeStageSize(800, 0, 16, 9)).toBeNull()
    expect(computeStageSize(800, 600, 0, 9)).toBeNull()
  })

  it('a small available area is never enlarged past what actually fits', () => {
    const size = computeStageSize(300, 200, 16, 9)!
    expect(size.width).toBeLessThanOrEqual(300)
    expect(size.height).toBeLessThanOrEqual(200)
  })
})
