import { describe, it, expect } from 'vitest'
import { computeDesignFit, screenToDesign, designToScreen, isCompactAspectRatio } from './designScale'

describe('computeDesignFit', () => {
  it('computes a uniform contain-fit scale when the stage exactly matches the design aspect ratio', () => {
    const fit = computeDesignFit(960, 540, '16:9') // half of 1920x1080, same ratio
    expect(fit.scale).toBeCloseTo(0.5, 5)
    expect(fit.offsetX).toBeCloseTo(0, 5)
    expect(fit.offsetY).toBeCloseTo(0, 5)
  })

  it('uses the smaller of the two axis scales (contain-fit) when the stage is a different ratio than the design canvas', () => {
    // Stage is wider than 16:9 -- height is the limiting axis.
    const fit = computeDesignFit(2000, 540, '16:9')
    expect(fit.scale).toBeCloseTo(540 / 1080, 5)
    expect(fit.offsetY).toBeCloseTo(0, 5)
    expect(fit.offsetX).toBeGreaterThan(0) // letterboxed horizontally
  })

  it('uses the correct design size for 9:16 and 1:1', () => {
    const portrait = computeDesignFit(540, 960, '9:16')
    expect(portrait.designWidth).toBe(1080)
    expect(portrait.designHeight).toBe(1920)
    expect(portrait.scale).toBeCloseTo(0.5, 5)

    const square = computeDesignFit(270, 270, '1:1')
    expect(square.scale).toBeCloseTo(0.25, 5)
  })

  it('falls back to an identity fit for invalid/zero stage size instead of NaN or Infinity', () => {
    expect(computeDesignFit(0, 0, '16:9')).toMatchObject({ scale: 1, offsetX: 0, offsetY: 0 })
    expect(computeDesignFit(-10, 500, '16:9')).toMatchObject({ scale: 1, offsetX: 0, offsetY: 0 })
    expect(computeDesignFit(NaN, 500, '16:9')).toMatchObject({ scale: 1, offsetX: 0, offsetY: 0 })
  })
})

describe('screenToDesign / designToScreen', () => {
  it('round-trips a point through screen -> design -> screen', () => {
    const fit = computeDesignFit(2000, 540, '16:9')
    const original = { x: 1234, y: 321 }
    const design = screenToDesign(original.x, original.y, fit)
    const back = designToScreen(design.x, design.y, fit)
    expect(back.x).toBeCloseTo(original.x, 5)
    expect(back.y).toBeCloseTo(original.y, 5)
  })

  it('maps the design canvas center to the visual center of the stage', () => {
    const fit = computeDesignFit(1920, 1080, '16:9')
    const screenCenter = designToScreen(960, 540, fit) // design canvas center for 16:9
    expect(screenCenter.x).toBeCloseTo(960, 5)
    expect(screenCenter.y).toBeCloseTo(540, 5)
  })

  it('accounts for letterbox offset when the stage ratio does not match the design ratio', () => {
    const fit = computeDesignFit(2000, 540, '16:9') // horizontal letterboxing
    const designOrigin = screenToDesign(fit.offsetX, fit.offsetY, fit)
    expect(designOrigin.x).toBeCloseTo(0, 5)
    expect(designOrigin.y).toBeCloseTo(0, 5)
  })
})

describe('isCompactAspectRatio', () => {
  it('16:9 is not compact; 9:16 and 1:1 are', () => {
    expect(isCompactAspectRatio('16:9')).toBe(false)
    expect(isCompactAspectRatio('9:16')).toBe(true)
    expect(isCompactAspectRatio('1:1')).toBe(true)
  })
})
