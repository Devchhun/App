import type { SceneContentTransform, ScenePosition } from '@shared/templates'
import { screenToDesign, designToScreen, type DesignFit } from '../templates/designScale'

export const MIN_CONTENT_SIZE_PERCENT = 5

/** Minimum distance (percent) any transformed edge must keep from the canvas
 * border -- content should never touch the frame edge. The single source of
 * truth for "the video safe area" used by dragging, resizing, and reflow
 * (contentTransformReflow.ts re-exports this rather than declaring its own). */
export const SAFE_AREA_MARGIN_PERCENT = 4

export type ContentHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

/** A content box's edges, in the same normalized percent units as
 * `SceneContentTransform` -- the intermediate shape every drag/resize/clamp
 * operation actually works in, since edges (not a center point) are what
 * "does this box fit inside the safe area" needs to reason about. */
export interface ContentBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** left/top/right/bottom of the safe area content must stay within --
 * defaults to the full 0-100 canvas when a caller doesn't have a stricter
 * margin available (e.g. a pure round-trip test). */
export interface SafeAreaBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export const FULL_CANVAS_SAFE_AREA: SafeAreaBounds = { left: 0, top: 0, right: 100, bottom: 100 }

/** The video canvas's safe area, `SAFE_AREA_MARGIN_PERCENT` in from every
 * edge -- the default safe area for dragging/resizing/recovery, matching the
 * margin `contentTransformReflow.ts` already uses for aspect-ratio reflow. */
export const DEFAULT_SAFE_AREA: SafeAreaBounds = {
  left: SAFE_AREA_MARGIN_PERCENT,
  top: SAFE_AREA_MARGIN_PERCENT,
  right: 100 - SAFE_AREA_MARGIN_PERCENT,
  bottom: 100 - SAFE_AREA_MARGIN_PERCENT
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** xPercent/yPercent are the box's normalized CENTER (see SceneContentTransform's
 * doc comment) -- this is the one place that fact turns into edges:
 *   left = xPercent - widthPercent / 2, right = xPercent + widthPercent / 2
 *   top = yPercent - heightPercent / 2, bottom = yPercent + heightPercent / 2 */
export function contentTransformToBounds(t: Pick<SceneContentTransform, 'xPercent' | 'yPercent' | 'widthPercent' | 'heightPercent'>): ContentBounds {
  return {
    left: t.xPercent - t.widthPercent / 2,
    top: t.yPercent - t.heightPercent / 2,
    right: t.xPercent + t.widthPercent / 2,
    bottom: t.yPercent + t.heightPercent / 2
  }
}

/** Inverse of contentTransformToBounds -- derives center/size from edges,
 * keeping every other field (rotation, lockAspectRatio) from `base`. */
export function boundsToContentTransform(bounds: ContentBounds, base: SceneContentTransform): SceneContentTransform {
  const widthPercent = bounds.right - bounds.left
  const heightPercent = bounds.bottom - bounds.top
  return {
    ...base,
    xPercent: bounds.left + widthPercent / 2,
    yPercent: bounds.top + heightPercent / 2,
    widthPercent,
    heightPercent
  }
}

/** Clamps a content transform's FULL box inside a safe area -- not just its
 * center. If the box is wider/taller than the safe area, it is shrunk first
 * (each axis independently, so an oversized-on-one-axis box only loses size
 * on that axis); only then is the center clamped so both edges stay inside.
 * Shrinking before clamping the center is what keeps the center's valid
 * range from ever inverting (min > max) -- an inverted range is what made a
 * dragged-off-canvas box permanently stuck: `clamp(x, min, max)` with
 * max < min collapses to a constant, silently ignoring every further delta
 * regardless of direction. This function can never produce that state.
 *
 * This is the "Constrain to canvas: On" / Fit to Canvas behavior -- ordinary
 * dragging and resizing do NOT call this by default (see
 * `clampContentTransformUnconstrained`, `applyContentDrag`'s
 * `constrainToCanvas` parameter): a scene is allowed to sit partially or
 * fully outside the video canvas (e.g. an element animating in from
 * off-frame), clipped only visually by the stage's own `overflow: hidden`,
 * never by rewriting the saved transform. */
export function clampContentTransform(t: SceneContentTransform, safeArea: SafeAreaBounds = DEFAULT_SAFE_AREA): SceneContentTransform {
  const safeWidth = Math.max(MIN_CONTENT_SIZE_PERCENT, safeArea.right - safeArea.left)
  const safeHeight = Math.max(MIN_CONTENT_SIZE_PERCENT, safeArea.bottom - safeArea.top)

  const widthPercent = clamp(t.widthPercent, MIN_CONTENT_SIZE_PERCENT, safeWidth)
  const heightPercent = clamp(t.heightPercent, MIN_CONTENT_SIZE_PERCENT, safeHeight)

  const xPercent = clamp(t.xPercent, safeArea.left + widthPercent / 2, safeArea.right - widthPercent / 2)
  const yPercent = clamp(t.yPercent, safeArea.top + heightPercent / 2, safeArea.bottom - heightPercent / 2)

  return { ...t, xPercent, yPercent, widthPercent, heightPercent }
}

/** Generous, independent numeric sanity bounds for each field -- NOT a "box
 * must fit inside this area" constraint like `SafeAreaBounds`. Only exists
 * to keep persisted/typed values finite and sane (no NaN/Infinity, no
 * literally-zero or runaway size), while still allowing a graphic to sit
 * far outside the visible canvas on purpose. */
export interface NumericSafetyLimits {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minWidth: number
  maxWidth: number
  maxHeight: number
  minHeight: number
}

export const UNCONSTRAINED_SAFETY_LIMITS: NumericSafetyLimits = {
  minX: -200,
  maxX: 300,
  minY: -200,
  maxY: 300,
  minWidth: 1,
  maxWidth: 500,
  minHeight: 1,
  maxHeight: 500
}

/** "Constrain to canvas: Off" (the default) -- each field is independently
 * clamped to a generous numeric safety range instead of the box as a whole
 * being forced to fit inside the canvas. A graphic can be dragged half off
 * an edge, enlarged past the frame, or made very small; only genuinely
 * invalid values (NaN, absurd magnitudes) are rejected. */
export function clampContentTransformUnconstrained(t: SceneContentTransform, limits: NumericSafetyLimits = UNCONSTRAINED_SAFETY_LIMITS): SceneContentTransform {
  return {
    ...t,
    xPercent: Number.isFinite(t.xPercent) ? clamp(t.xPercent, limits.minX, limits.maxX) : 50,
    yPercent: Number.isFinite(t.yPercent) ? clamp(t.yPercent, limits.minY, limits.maxY) : 50,
    widthPercent: Number.isFinite(t.widthPercent) ? clamp(t.widthPercent, limits.minWidth, limits.maxWidth) : 60,
    heightPercent: Number.isFinite(t.heightPercent) ? clamp(t.heightPercent, limits.minHeight, limits.maxHeight) : 50
  }
}

/** Converts a pointer position in stage pixels into the same normalized
 * design-space point templates/the selection overlay already share --
 * a thin, explicitly-named alias of designScale's screenToDesign so callers
 * reasoning about content transforms don't need to know that name. */
export const screenPointToDesignPoint = screenToDesign

/** Inverse of screenPointToDesignPoint. */
export const designPointToScreenPoint = designToScreen

/** Applies one pointer-drag delta (already converted to design-space
 * percent, not screen pixels) to a content transform. By default
 * (`constrainToCanvas: false`, matching the Properties panel's "Constrain to
 * canvas" toggle, off by default) the result is only kept numerically sane
 * (`clampContentTransformUnconstrained`) -- the box is free to sit partially
 * or fully outside the canvas, enlarge past it, or shrink very small.
 * Passing `constrainToCanvas: true` instead forces the FULL resulting box to
 * fit inside `safeArea` (`clampContentTransform`) -- including recovering a
 * box that was already outside it when the drag began, since clamping is
 * always applied to the whole resulting box, not incrementally. Pure, so the
 * whole drag/resize/recovery math is testable without a pointer or a DOM. */
export function applyContentDrag(
  start: SceneContentTransform,
  handle: ContentHandle,
  deltaXPercent: number,
  deltaYPercent: number,
  constrainToCanvas = false,
  safeArea: SafeAreaBounds = DEFAULT_SAFE_AREA
): SceneContentTransform {
  const finalize = (t: SceneContentTransform): SceneContentTransform =>
    constrainToCanvas ? clampContentTransform(t, safeArea) : clampContentTransformUnconstrained(t)

  if (handle === 'move') {
    return finalize({ ...start, xPercent: start.xPercent + deltaXPercent, yPercent: start.yPercent + deltaYPercent })
  }

  const includesLeft = handle === 'nw' || handle === 'w' || handle === 'sw'
  const includesRight = handle === 'ne' || handle === 'e' || handle === 'se'
  const includesTop = handle === 'nw' || handle === 'n' || handle === 'ne'
  const includesBottom = handle === 'sw' || handle === 's' || handle === 'se'
  const isCorner = (includesLeft || includesRight) && (includesTop || includesBottom)

  const bounds = contentTransformToBounds(start)
  let { left, top, right, bottom } = bounds

  if (isCorner && start.lockAspectRatio) {
    // Intermediate bounds here only guard against degenerate math (zero/
    // negative/runaway size) -- the real business rule (canvas-constrained
    // vs. generous numeric safety) is applied once, below, by `finalize`.
    const maxSize = constrainToCanvas ? 100 : UNCONSTRAINED_SAFETY_LIMITS.maxWidth
    const aspect = start.widthPercent / Math.max(1e-6, start.heightPercent)
    const growX = includesLeft ? -deltaXPercent : deltaXPercent
    const growY = includesTop ? -deltaYPercent : deltaYPercent
    // Whichever axis moved further drives the resize; the other axis derives from it via the locked aspect ratio.
    const growWidth = Math.abs(growX) >= Math.abs(growY) ? growX : growY * aspect
    let widthPercent = clamp(start.widthPercent + growWidth, MIN_CONTENT_SIZE_PERCENT, maxSize)
    let heightPercent = widthPercent / aspect
    if (heightPercent < MIN_CONTENT_SIZE_PERCENT) {
      heightPercent = MIN_CONTENT_SIZE_PERCENT
      widthPercent = heightPercent * aspect
    } else if (heightPercent > maxSize) {
      heightPercent = maxSize
      widthPercent = heightPercent * aspect
    }
    // Keep the opposite corner anchored in place.
    if (includesLeft) left = right - widthPercent
    else right = left + widthPercent
    if (includesTop) top = bottom - heightPercent
    else bottom = top + heightPercent
  } else {
    if (includesLeft) left += deltaXPercent
    if (includesRight) right += deltaXPercent
    if (includesTop) top += deltaYPercent
    if (includesBottom) bottom += deltaYPercent

    // Enforce the minimum size on the axis being resized, keeping the
    // opposite (anchored) edge fixed rather than letting the box flip inside-out.
    if (right - left < MIN_CONTENT_SIZE_PERCENT) {
      if (includesLeft) left = right - MIN_CONTENT_SIZE_PERCENT
      else right = left + MIN_CONTENT_SIZE_PERCENT
    }
    if (bottom - top < MIN_CONTENT_SIZE_PERCENT) {
      if (includesTop) top = bottom - MIN_CONTENT_SIZE_PERCENT
      else bottom = top + MIN_CONTENT_SIZE_PERCENT
    }
  }

  const resized = boundsToContentTransform({ left, top, right, bottom }, start)
  return finalize(resized)
}

/** `ScenePosition` (used by plain "overlay" scenes -- the original 10
 * templates plus any cinematic template not switched to full-frame) keeps
 * its own long-standing TOP-LEFT storage contract (xPct/yPct = top-left
 * corner), unlike `SceneContentTransform`. Rather than duplicate the
 * drag/resize/clamp math for a second coordinate convention, this adapts
 * `ScenePosition` to the shared center-based `applyContentDrag` at the
 * boundary and converts the result straight back -- so both systems get the
 * exact same shrink-before-clamp / aspect-lock / min-size behavior, and a
 * `ScenePosition` box that ended up outside the canvas is just as
 * recoverable as a `SceneContentTransform` one. `constrainToCanvas` defaults
 * to false, same as `applyContentDrag` -- an overlay scene can be dragged
 * partially off-frame just like a full-frame one. */
export function applyScenePositionDrag(
  start: ScenePosition,
  handle: ContentHandle,
  deltaXPercent: number,
  deltaYPercent: number,
  lockAspectRatio: boolean,
  constrainToCanvas = false
): ScenePosition {
  const asTransform: SceneContentTransform = {
    xPercent: start.xPct + start.widthPct / 2,
    yPercent: start.yPct + start.heightPct / 2,
    widthPercent: start.widthPct,
    heightPercent: start.heightPct,
    rotation: 0,
    lockAspectRatio
  }
  const next = applyContentDrag(asTransform, handle, deltaXPercent, deltaYPercent, constrainToCanvas)
  return {
    xPct: next.xPercent - next.widthPercent / 2,
    yPct: next.yPercent - next.heightPercent / 2,
    widthPct: next.widthPercent,
    heightPct: next.heightPercent
  }
}

export const MIN_SCALE_PERCENT = 10
export const MAX_SCALE_PERCENT = 500

/** The Properties panel's "Scale %" reading -- relative to the template's
 * OWN aspect-specific default bounds (`getDefaultContentTransform`), not an
 * arbitrary 100%-of-canvas baseline, so "100% scale" always means "this
 * template's normal size," matching whatever that template's default width
 * happens to be. Falls back to 100 if the base has no usable width (should
 * not happen for a real default transform). */
export function computeScalePercent(transform: Pick<SceneContentTransform, 'widthPercent'>, baseTransform: Pick<SceneContentTransform, 'widthPercent'>): number {
  if (!(baseTransform.widthPercent > 0)) return 100
  return (transform.widthPercent / baseTransform.widthPercent) * 100
}

/** Inverse of computeScalePercent -- sets width/height proportionally from
 * the template's default bounds, keeping the CURRENT center in place (a
 * scale change grows/shrinks around the content's own center, never shifts
 * it). The one shared helper every Scale-control call site uses, so there is
 * never a second, conflicting way to derive width/height from a percent. */
export function applyScalePercent(
  transform: SceneContentTransform,
  baseTransform: Pick<SceneContentTransform, 'widthPercent' | 'heightPercent'>,
  scalePercent: number
): SceneContentTransform {
  const factor = clamp(Number.isFinite(scalePercent) ? scalePercent : 100, MIN_SCALE_PERCENT, MAX_SCALE_PERCENT) / 100
  return {
    ...transform,
    widthPercent: baseTransform.widthPercent * factor,
    heightPercent: baseTransform.heightPercent * factor
  }
}

/** Whether a scene's transform (position/size/rotation) can currently be
 * edited via drag/resize/the Properties panel. Explicitly only `locked`
 * gates this -- a scene being `linked` to an AI suggestion (auto-synced
 * text/timing, see syncScenes.ts) must NOT also block manual transform
 * edits; those are orthogonal concerns. Pure and named so both
 * SceneSelectionOverlay and ScenePropertiesPanel share one definition of
 * "editable" instead of each re-deriving it inline. */
export function canTransformScene(scene: { locked?: boolean }): boolean {
  return !scene.locked
}

/** Angle (degrees, 0 = pointer directly above center) from a center point to
 * a pointer position -- used by the optional rotation handle. */
export function angleFromCenter(centerX: number, centerY: number, pointerX: number, pointerY: number): number {
  return (Math.atan2(pointerY - centerY, pointerX - centerX) * 180) / Math.PI + 90
}

export function applyContentRotate(start: SceneContentTransform, startAngle: number, currentAngle: number): SceneContentTransform {
  return { ...start, rotation: start.rotation + (currentAngle - startAngle) }
}

/** A rendered box's rect in STAGE pixels (relative to the stage element's
 * own top-left, same coordinate origin `SceneSelectionOverlay` positions its
 * selection box in). */
export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/** Computes the exact stage-pixel rect a `SceneContentTransform` renders at,
 * WITHOUT measuring the DOM -- this is what both the template's own render
 * (via SceneContentFrame, one level of design-space-to-stage scale applied
 * by DesignCanvas) and the selection overlay must agree on, so they can
 * never drift apart or momentarily disagree during a layout/measurement
 * timing window. Mirrors SceneContentFrame.tsx's own outer-box math exactly:
 * width/height are `widthPercent`/`heightPercent` of the design canvas,
 * converted to stage pixels by `fit.scale`; the center (`xPercent`/`yPercent`)
 * converts the same way, then the box's top-left is derived by subtracting
 * half the (already-scaled) size. Deliberately ignores `rotation` (an
 * unrotated bounding box is what handles/hit-testing need; the CSS transform
 * still rotates the actual rendered content visually). */
export function contentTransformToStageRect(
  transform: Pick<SceneContentTransform, 'xPercent' | 'yPercent' | 'widthPercent' | 'heightPercent'>,
  fit: DesignFit
): PixelRect {
  const width = (transform.widthPercent / 100) * fit.designWidth * fit.scale
  const height = (transform.heightPercent / 100) * fit.designHeight * fit.scale
  const centerX = (transform.xPercent / 100) * fit.designWidth * fit.scale + fit.offsetX
  const centerY = (transform.yPercent / 100) * fit.designHeight * fit.scale + fit.offsetY
  return { left: centerX - width / 2, top: centerY - height / 2, width, height }
}

/** Same idea as `contentTransformToStageRect`, for the older top-left-based
 * `ScenePosition` -- stage percentages convert directly to stage pixels,
 * with no design-canvas indirection (ScenePosition has always been relative
 * to the raw stage, not a logical design canvas). */
export function positionToStageRect(position: ScenePosition, stageWidth: number, stageHeight: number): PixelRect {
  return {
    left: (position.xPct / 100) * stageWidth,
    top: (position.yPct / 100) * stageHeight,
    width: (position.widthPct / 100) * stageWidth,
    height: (position.heightPct / 100) * stageHeight
  }
}

/** Re-exported so callers that only need the fit type don't have to reach
 * into designScale.ts directly. */
export type { DesignFit }
