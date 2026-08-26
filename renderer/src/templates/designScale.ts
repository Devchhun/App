import { CANVAS_SIZE_BY_ASPECT } from '@shared/templates'

export type AnyAspectRatio = keyof typeof CANVAS_SIZE_BY_ASPECT

/** How the fixed logical design canvas (1920x1080 for 16:9, etc) maps onto
 * the actually-measured video stage: a uniform contain-fit scale plus the
 * centering offset, in stage pixels. The rendered template (DesignCanvas),
 * the foreground selection overlay, and pointer-to-design conversion all
 * derive this from the same stageSize/aspectRatio inputs via this one
 * function, so they can never drift out of sync with each other. */
export interface DesignFit {
  scale: number
  offsetX: number
  offsetY: number
  designWidth: number
  designHeight: number
}

const IDENTITY_FIT_FALLBACK = { scale: 1, offsetX: 0, offsetY: 0 }

export function computeDesignFit(stageWidthPx: number, stageHeightPx: number, aspectRatio: AnyAspectRatio): DesignFit {
  const { width: designWidth, height: designHeight } = CANVAS_SIZE_BY_ASPECT[aspectRatio]
  if (!Number.isFinite(stageWidthPx) || !Number.isFinite(stageHeightPx) || stageWidthPx <= 0 || stageHeightPx <= 0) {
    return { ...IDENTITY_FIT_FALLBACK, designWidth, designHeight }
  }
  const scale = Math.min(stageWidthPx / designWidth, stageHeightPx / designHeight)
  const offsetX = (stageWidthPx - designWidth * scale) / 2
  const offsetY = (stageHeightPx - designHeight * scale) / 2
  return { scale, offsetX, offsetY, designWidth, designHeight }
}

/** Converts a point in stage pixels (e.g. a pointer event's position
 * relative to the stage element) into design-space coordinates. */
export function screenToDesign(screenX: number, screenY: number, fit: DesignFit): { x: number; y: number } {
  const scale = fit.scale || 1
  return { x: (screenX - fit.offsetX) / scale, y: (screenY - fit.offsetY) / scale }
}

/** Converts a design-space point into stage pixels -- the inverse of screenToDesign. */
export function designToScreen(designX: number, designY: number, fit: DesignFit): { x: number; y: number } {
  return { x: designX * fit.scale + fit.offsetX, y: designY * fit.scale + fit.offsetY }
}

/** 16:9 is landscape/wide -- the cinematic templates' default multi-column,
 * single-row compositions fit. 9:16 and 1:1 are both narrower than they are
 * wide relative to a 16:9 layout's needs, so both use each template's
 * compact/stacked variant rather than merely shrinking the 16:9 version. */
export function isCompactAspectRatio(aspectRatio: AnyAspectRatio): boolean {
  return aspectRatio !== '16:9'
}
