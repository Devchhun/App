import { describe, it, expect } from 'vitest'
import {
  applyContentDrag,
  applyScenePositionDrag,
  applyContentRotate,
  angleFromCenter,
  contentTransformToBounds,
  boundsToContentTransform,
  clampContentTransform,
  clampContentTransformUnconstrained,
  contentTransformToStageRect,
  positionToStageRect,
  screenPointToDesignPoint,
  designPointToScreenPoint,
  MIN_CONTENT_SIZE_PERCENT,
  DEFAULT_SAFE_AREA,
  SAFE_AREA_MARGIN_PERCENT,
  UNCONSTRAINED_SAFETY_LIMITS,
  MIN_SCALE_PERCENT,
  MAX_SCALE_PERCENT,
  computeScalePercent,
  applyScalePercent,
  canTransformScene,
  type ContentHandle
} from './contentTransformMath'
import type { SceneContentTransform } from '@shared/templates'
import type { DesignFit } from '../templates/designScale'

// xPercent/yPercent are the box's CENTER -- a 60x50 box centered at (50,50)
// spans left=20, top=25, right=80, bottom=75.
const BASE: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false }

describe('contentTransformToBounds / boundsToContentTransform', () => {
  it('1. round-trips center<->bounds exactly', () => {
    const bounds = contentTransformToBounds(BASE)
    expect(bounds).toEqual({ left: 20, top: 25, right: 80, bottom: 75 })
    const back = boundsToContentTransform(bounds, BASE)
    expect(back).toEqual(BASE)
  })

  it('boundsToContentTransform keeps rotation/lockAspectRatio from the base, not the bounds', () => {
    const base: SceneContentTransform = { ...BASE, rotation: 15, lockAspectRatio: true }
    const next = boundsToContentTransform({ left: 0, top: 0, right: 10, bottom: 10 }, base)
    expect(next.rotation).toBe(15)
    expect(next.lockAspectRatio).toBe(true)
    expect(next.xPercent).toBe(5)
    expect(next.yPercent).toBe(5)
  })
})

describe('clampContentTransform (Constrain to canvas: On / Fit to Canvas)', () => {
  it('leaves an already-valid box untouched', () => {
    expect(clampContentTransform(BASE, DEFAULT_SAFE_AREA)).toEqual(BASE)
  })

  it('4. reduces an oversized width/height BEFORE clamping the center, instead of inverting the clamp range', () => {
    const oversized: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 150, heightPercent: 130, rotation: 0, lockAspectRatio: false }
    const next = clampContentTransform(oversized, DEFAULT_SAFE_AREA)
    const bounds = contentTransformToBounds(next)
    expect(next.widthPercent).toBeLessThanOrEqual(100 - 2 * SAFE_AREA_MARGIN_PERCENT + 1e-9)
    expect(next.heightPercent).toBeLessThanOrEqual(100 - 2 * SAFE_AREA_MARGIN_PERCENT + 1e-9)
    expect(bounds.left).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-9)
    expect(bounds.right).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-9)
  })

  it('9. recovers a transform whose center is already far outside the canvas (Fit to Canvas semantics)', () => {
    const offCanvas: SceneContentTransform = { xPercent: -400, yPercent: 900, widthPercent: 40, heightPercent: 30, rotation: 0, lockAspectRatio: false }
    const next = clampContentTransform(offCanvas, DEFAULT_SAFE_AREA)
    const bounds = contentTransformToBounds(next)
    expect(bounds.left).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-9)
    expect(bounds.top).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-9)
    expect(bounds.right).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-9)
    expect(bounds.bottom).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-9)
    // Size is untouched -- only an oversized box needs shrinking, not a
    // reasonably-sized one that simply drifted off-canvas.
    expect(next.widthPercent).toBe(40)
    expect(next.heightPercent).toBe(30)
  })

  it('never produces an inverted min>max clamp regardless of how extreme the input is', () => {
    const extreme: SceneContentTransform = { xPercent: 1e9, yPercent: -1e9, widthPercent: 1e6, heightPercent: -50, rotation: 0, lockAspectRatio: false }
    const next = clampContentTransform(extreme, DEFAULT_SAFE_AREA)
    expect(Number.isFinite(next.xPercent)).toBe(true)
    expect(Number.isFinite(next.yPercent)).toBe(true)
    expect(next.widthPercent).toBeGreaterThanOrEqual(MIN_CONTENT_SIZE_PERCENT)
    expect(next.heightPercent).toBeGreaterThanOrEqual(MIN_CONTENT_SIZE_PERCENT)
  })
})

describe('clampContentTransformUnconstrained (Constrain to canvas: Off -- the default)', () => {
  it('5. allows a negative center position (content dragged partially off the left/top edge)', () => {
    const next = clampContentTransformUnconstrained({ xPercent: -30, yPercent: -10, widthPercent: 40, heightPercent: 30, rotation: 0, lockAspectRatio: false })
    expect(next.xPercent).toBe(-30)
    expect(next.yPercent).toBe(-10)
  })

  it('6. allows width/height greater than 100%', () => {
    const next = clampContentTransformUnconstrained({ xPercent: 50, yPercent: 50, widthPercent: 250, heightPercent: 180, rotation: 0, lockAspectRatio: false })
    expect(next.widthPercent).toBe(250)
    expect(next.heightPercent).toBe(180)
  })

  it('still rejects non-finite/NaN values with a sane fallback rather than propagating them', () => {
    const next = clampContentTransformUnconstrained({ xPercent: NaN, yPercent: Infinity, widthPercent: NaN, heightPercent: -Infinity, rotation: 0, lockAspectRatio: false })
    expect(Number.isFinite(next.xPercent)).toBe(true)
    expect(Number.isFinite(next.yPercent)).toBe(true)
    expect(Number.isFinite(next.widthPercent)).toBe(true)
    expect(Number.isFinite(next.heightPercent)).toBe(true)
  })

  it('caps at the generous absolute safety limits, not 0-100', () => {
    const next = clampContentTransformUnconstrained({ xPercent: 1e9, yPercent: -1e9, widthPercent: 1e9, heightPercent: -1e9, rotation: 0, lockAspectRatio: false })
    expect(next.xPercent).toBe(UNCONSTRAINED_SAFETY_LIMITS.maxX)
    expect(next.yPercent).toBe(UNCONSTRAINED_SAFETY_LIMITS.minY)
    expect(next.widthPercent).toBe(UNCONSTRAINED_SAFETY_LIMITS.maxWidth)
    expect(next.heightPercent).toBe(UNCONSTRAINED_SAFETY_LIMITS.minHeight)
  })
})

describe('applyContentDrag', () => {
  it('move translates the center without touching size', () => {
    const next = applyContentDrag(BASE, 'move', 10, -5)
    expect(next).toEqual({ ...BASE, xPercent: 60, yPercent: 45 })
  })

  it('5. by default (constrainToCanvas false), a graphic can be dragged so it sits partially outside the canvas', () => {
    const next = applyContentDrag(BASE, 'move', -60, -60) // center becomes (-10, -10) -- well outside [0,100]
    expect(next.xPercent).toBeLessThan(0)
    expect(next.yPercent).toBeLessThan(0)
  })

  it('7. with constrainToCanvas true, the box is pulled back inside the safe area', () => {
    const next = applyContentDrag(BASE, 'move', -60, -60, true)
    const bounds = contentTransformToBounds(next)
    expect(bounds.left).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-9)
    expect(bounds.top).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-9)
  })

  it('east handle grows width by moving only the right edge', () => {
    const next = applyContentDrag(BASE, 'e', 10, 999)
    const bounds = contentTransformToBounds(next)
    expect(bounds.left).toBe(20)
    expect(bounds.right).toBe(90)
    expect(next.widthPercent).toBe(70)
    expect(next.heightPercent).toBe(BASE.heightPercent)
  })

  it('west handle grows width by moving only the left edge', () => {
    const next = applyContentDrag(BASE, 'w', -10, 0)
    const bounds = contentTransformToBounds(next)
    expect(bounds.left).toBe(10)
    expect(bounds.right).toBe(80)
    expect(next.widthPercent).toBe(70)
  })

  it('south handle grows height by moving only the bottom edge', () => {
    const next = applyContentDrag(BASE, 's', 999, 10)
    const bounds = contentTransformToBounds(next)
    expect(bounds.top).toBe(25)
    expect(bounds.bottom).toBe(85)
    expect(next.heightPercent).toBe(60)
  })

  it('north handle grows height by moving only the top edge', () => {
    const next = applyContentDrag(BASE, 'n', 0, -10)
    const bounds = contentTransformToBounds(next)
    expect(bounds.top).toBe(15)
    expect(bounds.bottom).toBe(75)
    expect(next.heightPercent).toBe(60)
  })

  it('a corner handle without lockAspectRatio resizes both axes independently, anchoring the opposite corner', () => {
    const next = applyContentDrag(BASE, 'se', 10, 5)
    const bounds = contentTransformToBounds(next)
    expect(bounds.left).toBe(20)
    expect(bounds.top).toBe(25)
    expect(next.widthPercent).toBe(70)
    expect(next.heightPercent).toBe(55)
  })

  it('6. a corner drag can enlarge the box well past 100% width when unconstrained', () => {
    const next = applyContentDrag(BASE, 'se', 200, 150)
    expect(next.widthPercent).toBeGreaterThan(100)
  })

  it('never shrinks below the minimum size, keeping the opposite edge anchored', () => {
    const next = applyContentDrag(BASE, 'e', -999, 0)
    expect(next.widthPercent).toBe(MIN_CONTENT_SIZE_PERCENT)
    expect(contentTransformToBounds(next).left).toBe(20)
  })

  it('7. constrainToCanvas true shrinks an oversized resize instead of exceeding the safe area', () => {
    const next = applyContentDrag(BASE, 'e', 200, 0, true)
    expect(next.widthPercent).toBeLessThanOrEqual(100 - 2 * SAFE_AREA_MARGIN_PERCENT + 1e-9)
    const bounds = contentTransformToBounds(next)
    expect(bounds.left).toBeGreaterThanOrEqual(SAFE_AREA_MARGIN_PERCENT - 1e-9)
    expect(bounds.right).toBeLessThanOrEqual(100 - SAFE_AREA_MARGIN_PERCENT + 1e-9)
  })

  describe('lockAspectRatio', () => {
    const locked: SceneContentTransform = { ...BASE, widthPercent: 60, heightPercent: 40, lockAspectRatio: true }

    it('a corner drag preserves the aspect ratio', () => {
      const next = applyContentDrag(locked, 'se', 30, 5) // horizontal delta dominates
      const startAspect = locked.widthPercent / locked.heightPercent
      const nextAspect = next.widthPercent / next.heightPercent
      expect(nextAspect).toBeCloseTo(startAspect, 5)
      expect(next.widthPercent).toBeGreaterThan(locked.widthPercent)
    })

    it('8. corner resize changes the actual content scale (widthPercent/heightPercent both grow, aspect preserved)', () => {
      const next = applyContentDrag(locked, 'nw', -40, -30)
      expect(next.widthPercent).toBeGreaterThan(locked.widthPercent)
      expect(next.heightPercent).toBeGreaterThan(locked.heightPercent)
      expect(next.widthPercent / next.heightPercent).toBeCloseTo(locked.widthPercent / locked.heightPercent, 5)
    })

    it('keeps the opposite corner anchored in place while resizing', () => {
      const next = applyContentDrag(locked, 'se', 10, 2)
      const startBounds = contentTransformToBounds(locked)
      const nextBounds = contentTransformToBounds(next)
      // se drag: the nw corner must not move.
      expect(nextBounds.left).toBeCloseTo(startBounds.left, 5)
      expect(nextBounds.top).toBeCloseTo(startBounds.top, 5)
    })

    it('constrainToCanvas true still clamps to the canvas edge even when locked, taking priority over keeping the anchor fixed', () => {
      const next = applyContentDrag(locked, 'se', 30, 5, true)
      const bounds = contentTransformToBounds(next)
      expect(bounds.right).toBeLessThanOrEqual(100 + 1e-9)
      expect(bounds.bottom).toBeLessThanOrEqual(100 + 1e-9)
    })

    it('an edge handle still resizes only its own axis even when locked', () => {
      const next = applyContentDrag(locked, 'e', 10, 0)
      expect(next.heightPercent).toBe(locked.heightPercent)
      expect(next.widthPercent).toBe(70)
    })

    it('nw drag keeps the opposite (se) corner anchored', () => {
      const next = applyContentDrag(locked, 'nw', -20, -5)
      const startBounds = contentTransformToBounds(locked)
      const nextBounds = contentTransformToBounds(next)
      expect(nextBounds.right).toBeCloseTo(startBounds.right, 5)
      expect(nextBounds.bottom).toBeCloseTo(startBounds.bottom, 5)
    })
  })

  it('every handle can resize from a box already sitting at the canvas edge', () => {
    const atEdge: SceneContentTransform = { xPercent: MIN_CONTENT_SIZE_PERCENT / 2, yPercent: MIN_CONTENT_SIZE_PERCENT / 2, widthPercent: MIN_CONTENT_SIZE_PERCENT, heightPercent: MIN_CONTENT_SIZE_PERCENT, rotation: 0, lockAspectRatio: false }
    const handles: ContentHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move']
    for (const handle of handles) {
      const next = applyContentDrag(atEdge, handle, 5, 5)
      const bounds = contentTransformToBounds(next)
      expect(Number.isFinite(bounds.left)).toBe(true)
      expect(bounds.right).toBeGreaterThan(bounds.left)
      expect(bounds.bottom).toBeGreaterThan(bounds.top)
    }
  })
})

describe('applyScenePositionDrag (ScenePosition -- top-left storage, adapted to the shared math)', () => {
  const position = { xPct: 20, yPct: 25, widthPct: 60, heightPct: 50 }

  it('move translates top-left directly', () => {
    const next = applyScenePositionDrag(position, 'move', 10, -5, false)
    expect(next).toEqual({ xPct: 30, yPct: 20, widthPct: 60, heightPct: 50 })
  })

  it('5. allows a ScenePosition box to be dragged partially outside the canvas by default', () => {
    const next = applyScenePositionDrag(position, 'move', -60, 0, false)
    expect(next.xPct).toBeLessThan(0)
  })

  it('recovers a ScenePosition box already stuck outside the canvas when constrainToCanvas is on (the originally reported Cause-and-Effect Flow bug)', () => {
    // widthPct > 100 - xPct is exactly the shape that inverted the OLD
    // `clamp(x, 0, 100 - widthPct)` call: 100 - widthPct was negative, so
    // every further drag delta was silently ignored regardless of direction.
    const stuck = { xPct: -30, yPct: 10, widthPct: 140, heightPct: 50 }
    const next = applyScenePositionDrag(stuck, 'move', 5, 0, false, true)
    expect(next.xPct).not.toBe(stuck.xPct)
    expect(next.xPct).toBeGreaterThanOrEqual(0)
    expect(next.xPct + next.widthPct).toBeLessThanOrEqual(100 + 1e-9)
  })

  it('a corner drag respects lockAspectRatio the same way applyContentDrag does', () => {
    const next = applyScenePositionDrag(position, 'se', 30, 5, true)
    const startAspect = position.widthPct / position.heightPct
    expect(next.widthPct / next.heightPct).toBeCloseTo(startAspect, 5)
  })

  it('an edge handle resizes only its own axis regardless of lockAspectRatio', () => {
    const next = applyScenePositionDrag(position, 'e', 10, 0, true)
    expect(next.heightPct).toBe(position.heightPct)
  })
})

describe('contentTransformToStageRect / positionToStageRect', () => {
  const fit: DesignFit = { scale: 0.5, offsetX: 40, offsetY: 20, designWidth: 1920, designHeight: 1080 }

  it('computes the stage-pixel rect matching SceneContentFrame\'s own outer-box math, without measuring the DOM', () => {
    const transform: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 20, heightPercent: 30, rotation: 0, lockAspectRatio: false }
    const rect = contentTransformToStageRect(transform, fit)
    const expectedWidth = 0.2 * 1920 * 0.5 // 192
    const expectedHeight = 0.3 * 1080 * 0.5 // 162
    expect(rect.width).toBeCloseTo(expectedWidth, 5)
    expect(rect.height).toBeCloseTo(expectedHeight, 5)
    const expectedCenterX = 0.5 * 1920 * 0.5 + 40
    const expectedCenterY = 0.5 * 1080 * 0.5 + 20
    expect(rect.left).toBeCloseTo(expectedCenterX - expectedWidth / 2, 5)
    expect(rect.top).toBeCloseTo(expectedCenterY - expectedHeight / 2, 5)
  })

  it('a full-frame (100%x100%, centered) transform resolves to the WHOLE fitted design canvas, not a fraction of it', () => {
    const transform: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 100, heightPercent: 100, rotation: 0, lockAspectRatio: false }
    const rect = contentTransformToStageRect(transform, fit)
    expect(rect.width).toBeCloseTo(1920 * 0.5, 5)
    expect(rect.height).toBeCloseTo(1080 * 0.5, 5)
  })

  it('a small centered transform (e.g. a device-lineup card default) resolves to a proportionally small rect, never the full stage', () => {
    const small: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 30, heightPercent: 25, rotation: 0, lockAspectRatio: false }
    const rect = contentTransformToStageRect(small, fit)
    const fullFrameRect = contentTransformToStageRect({ ...small, widthPercent: 100, heightPercent: 100 }, fit)
    expect(rect.width).toBeLessThan(fullFrameRect.width)
    expect(rect.height).toBeLessThan(fullFrameRect.height)
  })

  it('positionToStageRect converts ScenePosition percentages directly against stage pixels (no design-canvas indirection)', () => {
    const rect = positionToStageRect({ xPct: 10, yPct: 20, widthPct: 30, heightPct: 40 }, 1000, 500)
    expect(rect).toEqual({ left: 100, top: 100, width: 300, height: 200 })
  })
})

describe('screenPointToDesignPoint / designPointToScreenPoint', () => {
  const fit: DesignFit = { scale: 0.5, offsetX: 40, offsetY: 20, designWidth: 1920, designHeight: 1080 }

  it('converts a screen point (with Fit-mode letterbox offsets) into the matching design-space point', () => {
    const design = screenPointToDesignPoint(240, 120, fit)
    expect(design.x).toBeCloseTo((240 - 40) / 0.5, 5)
    expect(design.y).toBeCloseTo((120 - 20) / 0.5, 5)
  })

  it('round-trips screen -> design -> screen exactly', () => {
    const screen = { x: 300, y: 150 }
    const design = screenPointToDesignPoint(screen.x, screen.y, fit)
    const back = designPointToScreenPoint(design.x, design.y, fit)
    expect(back.x).toBeCloseTo(screen.x, 6)
    expect(back.y).toBeCloseTo(screen.y, 6)
  })
})

describe('angleFromCenter', () => {
  it('is 0 degrees for a point directly above center', () => {
    expect(angleFromCenter(0, 0, 0, -100)).toBeCloseTo(0, 5)
  })

  it('is 90 degrees for a point directly right of center', () => {
    expect(angleFromCenter(0, 0, 100, 0)).toBeCloseTo(90, 5)
  })
})

describe('applyContentRotate', () => {
  it('adds the angle delta to the starting rotation', () => {
    const start: SceneContentTransform = { ...BASE, rotation: 10 }
    const next = applyContentRotate(start, 0, 30)
    expect(next.rotation).toBe(40)
  })
})

describe('canTransformScene', () => {
  it('5. a linked (but not locked) scene remains transformable', () => {
    expect(canTransformScene({ locked: false, linked: true } as { locked?: boolean; linked?: boolean })).toBe(true)
    expect(canTransformScene({ linked: true } as { locked?: boolean; linked?: boolean })).toBe(true)
  })

  it('6. an explicitly locked scene is not transformable, regardless of linked status', () => {
    expect(canTransformScene({ locked: true })).toBe(false)
    expect(canTransformScene({ locked: true, linked: true } as { locked?: boolean; linked?: boolean })).toBe(false)
    expect(canTransformScene({ locked: true, linked: false } as { locked?: boolean; linked?: boolean })).toBe(false)
  })

  it('defaults to transformable when locked is unset', () => {
    expect(canTransformScene({})).toBe(true)
  })
})

describe('computeScalePercent / applyScalePercent (Properties panel Scale control)', () => {
  const base: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 40, rotation: 0, lockAspectRatio: false }

  it('reads 100% when the transform exactly matches the template default', () => {
    expect(computeScalePercent(base, base)).toBeCloseTo(100, 5)
  })

  it('reads a proportional percent when the transform is larger/smaller than the default', () => {
    const bigger: SceneContentTransform = { ...base, widthPercent: 90 }
    expect(computeScalePercent(bigger, base)).toBeCloseTo(150, 5)
    const smaller: SceneContentTransform = { ...base, widthPercent: 30 }
    expect(computeScalePercent(smaller, base)).toBeCloseTo(50, 5)
  })

  it('9. changing Scale updates BOTH width and height proportionally from the default, around the current center', () => {
    const current: SceneContentTransform = { ...base, xPercent: 62, yPercent: 38, widthPercent: 60, heightPercent: 40 }
    const next = applyScalePercent(current, base, 150)
    expect(next.widthPercent).toBeCloseTo(90, 5) // 60 * 1.5
    expect(next.heightPercent).toBeCloseTo(60, 5) // 40 * 1.5
    // Center is untouched by a scale change.
    expect(next.xPercent).toBe(62)
    expect(next.yPercent).toBe(38)
  })

  it('clamps to the 10%-500% range instead of trusting an extreme typed value', () => {
    expect(applyScalePercent(base, base, 1).widthPercent).toBeCloseTo(base.widthPercent * (MIN_SCALE_PERCENT / 100), 5)
    expect(applyScalePercent(base, base, 9999).widthPercent).toBeCloseTo(base.widthPercent * (MAX_SCALE_PERCENT / 100), 5)
  })

  it('computeScalePercent and applyScalePercent round-trip', () => {
    const current: SceneContentTransform = { ...base, widthPercent: 45, heightPercent: 30 }
    const scale = computeScalePercent(current, base)
    const rebuilt = applyScalePercent(current, base, scale)
    expect(rebuilt.widthPercent).toBeCloseTo(current.widthPercent, 5)
    expect(rebuilt.heightPercent).toBeCloseTo(current.heightPercent, 5)
  })
})

describe('4. high-DPI screen-to-design coordinate conversion', () => {
  // Pointer events (`e.clientX`/`e.clientY`) are already reported in CSS
  // pixels by the browser, normalized for the OS display scale (100%/125%/
  // 150%/etc) -- screenPointToDesignPoint/designPointToScreenPoint never
  // read `window.devicePixelRatio` anywhere, so there is nothing to
  // "double-apply." The same visual pointer distance produces the same
  // design-space delta regardless of the monitor's DPI/scale setting, as
  // long as `fit` (computeDesignFit's output) was itself measured in CSS
  // pixels -- which getBoundingClientRect always returns.
  it('the same CSS-pixel delta produces the same design-space delta at any fit scale (DPI-scale-agnostic)', () => {
    const fitAt100 = { scale: 1, offsetX: 0, offsetY: 0, designWidth: 1920, designHeight: 1080 }
    const a = screenPointToDesignPoint(100, 100, fitAt100)
    const b = screenPointToDesignPoint(150, 130, fitAt100)
    expect(b.x - a.x).toBeCloseTo(50, 6)
    expect(b.y - a.y).toBeCloseTo(30, 6)
  })

  it('a smaller fit.scale (e.g. a physically smaller/higher-DPI-scaled stage) produces a proportionally larger design-space delta for the same CSS-pixel movement', () => {
    const smallStage = { scale: 0.25, offsetX: 0, offsetY: 0, designWidth: 1920, designHeight: 1080 }
    const largeStage = { scale: 0.5, offsetX: 0, offsetY: 0, designWidth: 1920, designHeight: 1080 }
    const deltaSmall = screenPointToDesignPoint(50, 0, smallStage).x - screenPointToDesignPoint(0, 0, smallStage).x
    const deltaLarge = screenPointToDesignPoint(50, 0, largeStage).x - screenPointToDesignPoint(0, 0, largeStage).x
    expect(deltaSmall).toBeCloseTo(deltaLarge * 2, 5) // half the scale -> double the design-space delta for the same screen delta
  })
})
