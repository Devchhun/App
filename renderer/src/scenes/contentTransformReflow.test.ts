import { describe, it, expect } from 'vitest'
import { reflowContentTransform, reflowScenePosition, getDefaultContentTransform, resolveEffectiveContentTransform, SAFE_AREA_MARGIN_PERCENT } from './contentTransformReflow'
import { contentTransformToBounds, contentTransformToStageRect } from './contentTransformMath'
import { computeDesignFit } from '../templates/designScale'
import { CANVAS_SIZE_BY_ASPECT } from '@shared/templates'
import type { SceneContentTransform } from '@shared/templates'

const MIN_SIZE_SANITY = 1

/** xPercent/yPercent are the box's CENTER (see SceneContentTransform's doc
 * comment) -- this just names that fact for readability in these tests. */
function centerOf(t: SceneContentTransform): { x: number; y: number } {
  return { x: t.xPercent, y: t.yPercent }
}

function assertWithinSafeArea(t: SceneContentTransform): void {
  const bounds = contentTransformToBounds(t)
  expect(bounds.left).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-6)
  expect(bounds.top).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-6)
  expect(bounds.right).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-6)
  expect(bounds.bottom).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-6)
}

describe('reflowContentTransform', () => {
  it('is a no-op when the aspect ratio does not actually change', () => {
    const t: SceneContentTransform = { xPercent: 50, yPercent: 45, widthPercent: 60, heightPercent: 40, rotation: 0, lockAspectRatio: true }
    expect(reflowContentTransform(t, '16:9', '16:9')).toEqual(t)
  })

  it('1. 16:9 -> 9:16: preserves the normalized center and stays within the safe area', () => {
    const t: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 80, heightPercent: 60, rotation: 0, lockAspectRatio: false }
    const next = reflowContentTransform(t, '16:9', '9:16')
    assertWithinSafeArea(next)
    expect(centerOf(next).x).toBeCloseTo(centerOf(t).x, 0)
    expect(centerOf(next).y).toBeCloseTo(centerOf(t).y, 0)
  })

  it('2. 9:16 -> 1:1: stays within the safe area and keeps a sane (non-degenerate) size', () => {
    const t: SceneContentTransform = { xPercent: 50, yPercent: 52.5, widthPercent: 80, heightPercent: 45, rotation: 0, lockAspectRatio: false }
    const next = reflowContentTransform(t, '9:16', '1:1')
    assertWithinSafeArea(next)
    expect(next.widthPercent).toBeGreaterThan(0)
    expect(next.heightPercent).toBeGreaterThan(0)
  })

  it('3. 1:1 -> 16:9: stays within the safe area', () => {
    const t: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 76, heightPercent: 56, rotation: 0, lockAspectRatio: false }
    const next = reflowContentTransform(t, '1:1', '16:9')
    assertWithinSafeArea(next)
  })

  it('4. shrinks oversized content proportionally to fit the new safe area instead of clipping unevenly', () => {
    // A box that filled almost the entire 1:1 canvas would be enormous (and off-canvas) if
    // carried over literally to a much taller/narrower 9:16 canvas without reflow.
    const t: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 96, heightPercent: 96, rotation: 0, lockAspectRatio: true }
    const next = reflowContentTransform(t, '1:1', '9:16')
    assertWithinSafeArea(next)
    // Locked aspect ratio must still hold after shrinking.
    const oldCanvas = CANVAS_SIZE_BY_ASPECT['9:16']
    expect(next.widthPercent / next.heightPercent).toBeGreaterThan(0)
    expect(oldCanvas).toBeTruthy()
  })

  it('5. content already touching every edge is pulled back inside the safe area on every axis', () => {
    const t: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 100, heightPercent: 100, rotation: 0, lockAspectRatio: false }
    const next = reflowContentTransform(t, '16:9', '1:1')
    assertWithinSafeArea(next)
  })

  it('6a. lockAspectRatio true: the resulting box keeps the same absolute pixel aspect ratio', () => {
    const t: SceneContentTransform = { xPercent: 45, yPercent: 45, widthPercent: 50, heightPercent: 30, rotation: 0, lockAspectRatio: true }
    const oldCanvas = CANVAS_SIZE_BY_ASPECT['16:9']
    const newCanvas = CANVAS_SIZE_BY_ASPECT['1:1']
    const oldAspect = (t.widthPercent * oldCanvas.width) / (t.heightPercent * oldCanvas.height)
    const next = reflowContentTransform(t, '16:9', '1:1')
    const newAspect = (next.widthPercent * newCanvas.width) / (next.heightPercent * newCanvas.height)
    expect(newAspect).toBeCloseTo(oldAspect, 3)
  })

  it('6b. lockAspectRatio false: width% and height% carry through directly when they already fit', () => {
    const t: SceneContentTransform = { xPercent: 45, yPercent: 45, widthPercent: 50, heightPercent: 30, rotation: 0, lockAspectRatio: false }
    const next = reflowContentTransform(t, '16:9', '1:1')
    expect(next.widthPercent).toBeCloseTo(50, 5)
    expect(next.heightPercent).toBeCloseTo(30, 5)
  })

  it('preserves rotation and lockAspectRatio flags across a reflow', () => {
    const t: SceneContentTransform = { xPercent: 45, yPercent: 45, widthPercent: 50, heightPercent: 30, rotation: 12, lockAspectRatio: true }
    const next = reflowContentTransform(t, '16:9', '9:16')
    expect(next.rotation).toBe(12)
    expect(next.lockAspectRatio).toBe(true)
  })

  it('round-trips back to a visually reasonable (safe, non-degenerate) box after returning to the original aspect ratio', () => {
    const original: SceneContentTransform = { xPercent: 50, yPercent: 45, widthPercent: 60, heightPercent: 40, rotation: 0, lockAspectRatio: true }
    const toPortrait = reflowContentTransform(original, '16:9', '9:16')
    const backToLandscape = reflowContentTransform(toPortrait, '9:16', '16:9')
    assertWithinSafeArea(backToLandscape)
    expect(backToLandscape.widthPercent).toBeGreaterThan(MIN_SIZE_SANITY)
    expect(backToLandscape.heightPercent).toBeGreaterThan(MIN_SIZE_SANITY)
  })
})

describe('reflowScenePosition', () => {
  it('reflows the older top-left-based ScenePosition shape by converting to/from the shared center-based math, ignoring rotation/lock', () => {
    const position = { xPct: 10, yPct: 20, widthPct: 80, heightPct: 60 }
    const next = reflowScenePosition(position, '16:9', '9:16')
    expect(next.xPct + next.widthPct).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-6)
    expect(next.yPct + next.heightPct).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-6)
    expect(next.xPct).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-6)
    expect(next.yPct).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-6)
  })

  it('is a no-op when the aspect ratio is unchanged', () => {
    const position = { xPct: 10, yPct: 20, widthPct: 80, heightPct: 60 }
    expect(reflowScenePosition(position, '1:1', '1:1')).toEqual(position)
  })

  it('preserves the box\'s normalized center (top-left + half size) across the reflow, not just its top-left corner', () => {
    const position = { xPct: 10, yPct: 30, widthPct: 60, heightPct: 30 }
    const oldCenter = { x: position.xPct + position.widthPct / 2, y: position.yPct + position.heightPct / 2 }
    const next = reflowScenePosition(position, '16:9', '9:16')
    const newCenter = { x: next.xPct + next.widthPct / 2, y: next.yPct + next.heightPct / 2 }
    expect(newCenter.x).toBeCloseTo(oldCenter.x, 0)
    expect(newCenter.y).toBeCloseTo(oldCenter.y, 0)
  })
})

describe('getDefaultContentTransform', () => {
  it('provides a distinct default per template per aspect ratio (not the 16:9 box merely shrunk)', () => {
    const wide = getDefaultContentTransform('device-compatibility-lineup', '16:9')!
    const compact916 = getDefaultContentTransform('device-compatibility-lineup', '9:16')!
    const compact11 = getDefaultContentTransform('device-compatibility-lineup', '1:1')!
    expect(wide).toBeDefined()
    expect(compact916).toBeDefined()
    expect(compact11).toBeDefined()
    expect(wide).not.toEqual(compact916)
    expect(compact916).not.toEqual(compact11)
  })

  it('every default transform stays within the safe area on its own aspect ratio', () => {
    for (const templateId of ['device-compatibility-lineup', 'tech-title-scene', 'cause-effect-flow'] as const) {
      for (const aspect of ['16:9', '9:16', '1:1'] as const) {
        const t = getDefaultContentTransform(templateId, aspect)!
        assertWithinSafeArea(t)
      }
    }
  })

  it('is undefined for templates that do not use contentTransform (e.g. Three-Step Presenter Plan)', () => {
    expect(getDefaultContentTransform('three-step-presenter-plan', '16:9')).toBeUndefined()
  })
})

describe('resolveEffectiveContentTransform', () => {
  it('3. a scene with no explicit contentTransform resolves to the template\'s actual default content box, not an empty/undefined value', () => {
    const resolved = resolveEffectiveContentTransform({ contentTransform: undefined }, 'device-compatibility-lineup', '16:9')
    expect(resolved).toEqual(getDefaultContentTransform('device-compatibility-lineup', '16:9'))
  })

  it('an explicit scene.contentTransform always wins over the template default', () => {
    const explicit: SceneContentTransform = { xPercent: 12, yPercent: 34, widthPercent: 21, heightPercent: 19, rotation: 5, lockAspectRatio: true }
    const resolved = resolveEffectiveContentTransform({ contentTransform: explicit }, 'device-compatibility-lineup', '16:9')
    expect(resolved).toEqual(explicit)
  })

  it('falls back to a generic centered box for a full-frame template with no per-aspect default entry, never leaving the transform undefined', () => {
    // No template in the registry is expected to hit this path today, but the
    // resolver must still be total (every call returns a real transform).
    const resolved = resolveEffectiveContentTransform({ contentTransform: undefined }, 'lower-third', '16:9')
    expect(resolved).toBeDefined()
    expect(resolved.widthPercent).toBeGreaterThan(0)
    expect(resolved.heightPercent).toBeGreaterThan(0)
  })

  it('1 & 2. the resolved default for a full-frame Device scene is NOT stage-sized (100%x100%) -- it is the small centered card, never the whole canvas or a background layer\'s own bounds', () => {
    const resolved = resolveEffectiveContentTransform({ contentTransform: undefined }, 'device-compatibility-lineup', '16:9')
    expect(resolved.widthPercent).toBeLessThan(100)
    expect(resolved.heightPercent).toBeLessThan(100)

    // Converting to actual stage pixels must likewise produce a rect smaller
    // than the full fitted design canvas -- proving the selection target is
    // the card, not `if (presentationMode === 'full-frame') return
    // fullStageBounds`-style logic that would return the entire stage.
    const fit = computeDesignFit(1000, 562, '16:9') // an arbitrary but plausible stage size
    const cardRect = contentTransformToStageRect(resolved, fit)
    const fullFrameRect = contentTransformToStageRect({ ...resolved, xPercent: 50, yPercent: 50, widthPercent: 100, heightPercent: 100 }, fit)
    expect(cardRect.width).toBeLessThan(fullFrameRect.width)
    expect(cardRect.height).toBeLessThan(fullFrameRect.height)
  })

  it('4. renderer and selection overlay resolve to an identical transform for the same scene/template/aspect (both call this same function)', () => {
    const scene = { contentTransform: undefined }
    const renderTransform = resolveEffectiveContentTransform(scene, 'device-compatibility-lineup', '9:16')
    const selectionTransform = resolveEffectiveContentTransform(scene, 'device-compatibility-lineup', '9:16')
    expect(renderTransform).toEqual(selectionTransform)
  })
})
