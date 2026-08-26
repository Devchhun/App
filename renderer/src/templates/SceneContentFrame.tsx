import type { CSSProperties, ReactNode } from 'react'
import { CANVAS_SIZE_BY_ASPECT } from '@shared/templates'
import type { SceneContentTransform } from '@shared/templates'
import type { AnyAspectRatio } from './designScale'

interface SceneContentFrameProps {
  transform: SceneContentTransform
  /** Must match the DesignCanvas this frame is rendered inside, since
   * `transform`'s percentages are normalized against that same design canvas. */
  aspectRatio: AnyAspectRatio
  /** The template's natural, unscaled composition size in design-space px --
   * i.e. the size its CSS is authored against before any user resize. */
  intrinsicWidth: number
  intrinsicHeight: number
  className?: string
  children: ReactNode
  /** Placed on the OUTER box (the one sized exactly to `transform`'s
   * width/height percent), not the inner scaled composition -- the
   * selection overlay measures whichever element carries this attribute, and
   * must measure the box matching the stored transform exactly, even when an
   * aspect-locked inner composition ends up letterboxed smaller inside it. */
  dataSceneId?: string
}

/** The one shared wrapper every editable (full-frame) template's foreground
 * content group renders through. Resizing the on-canvas selection box
 * doesn't just resize an outer CSS box that fixed-px children ignore -- it
 * computes a real inner `scale()` from `contentSize / intrinsicSize` and
 * applies it to the template's whole composition, so text, cards, icons,
 * SVG lines, borders, and shadows all grow/shrink together, exactly
 * matching the box the selection overlay draws (both are driven by the same
 * `transform`, measured against the same design canvas).
 *
 * The outer box is positioned/sized directly from `transform` (percent of
 * the design canvas -- the SAME units DesignCanvas's own outer scale
 * already accounts for one level up, so this component must never multiply
 * by that scale again). The inner box stays fixed at the template's
 * intrinsic design size and gets `transform: scale(...)` -- CSS scale, not
 * a width/height change, is what makes every descendant (however it's
 * sized) grow/shrink uniformly without each template having to make its own
 * internals percentage-based. */
export interface ContentFrameScale {
  contentWidthPx: number
  contentHeightPx: number
  scaleX: number
  scaleY: number
}

/** Pure scale math extracted so it's directly testable without rendering --
 * this is the calculation that guarantees a template's intrinsic-size
 * composition never exceeds the box the selection overlay draws (mirroring
 * SceneContentFrame.tsx's doc comment): `scaleX = contentWidth /
 * intrinsicWidth`, `scaleY = contentHeight / intrinsicHeight`, uniform
 * (min of the two) when aspect is locked so the composition is centered
 * inside the frame instead of stretched or spilling outside it. */
export function computeContentFrameScale(
  transform: Pick<SceneContentTransform, 'widthPercent' | 'heightPercent' | 'lockAspectRatio'>,
  aspectRatio: AnyAspectRatio,
  intrinsicWidth: number,
  intrinsicHeight: number
): ContentFrameScale {
  const { width: designWidth, height: designHeight } = CANVAS_SIZE_BY_ASPECT[aspectRatio]
  const contentWidthPx = Math.max(1, (transform.widthPercent / 100) * designWidth)
  const contentHeightPx = Math.max(1, (transform.heightPercent / 100) * designHeight)

  const rawScaleX = contentWidthPx / Math.max(1, intrinsicWidth)
  const rawScaleY = contentHeightPx / Math.max(1, intrinsicHeight)
  // Locked aspect ratio: one uniform scale, composition centered inside the
  // frame (matches the requested corner-handle behavior). Unlocked: each
  // axis scales independently so the composition exactly fills the resized
  // box (middle-handle behavior) instead of leaving empty space.
  const scaleX = transform.lockAspectRatio ? Math.min(rawScaleX, rawScaleY) : rawScaleX
  const scaleY = transform.lockAspectRatio ? Math.min(rawScaleX, rawScaleY) : rawScaleY

  return { contentWidthPx, contentHeightPx, scaleX, scaleY }
}

export function SceneContentFrame({ transform, aspectRatio, intrinsicWidth, intrinsicHeight, className, children, dataSceneId }: SceneContentFrameProps): JSX.Element {
  const { contentWidthPx, contentHeightPx, scaleX, scaleY } = computeContentFrameScale(transform, aspectRatio, intrinsicWidth, intrinsicHeight)

  const outerStyle: CSSProperties = {
    position: 'absolute',
    left: `${transform.xPercent}%`,
    top: `${transform.yPercent}%`,
    width: contentWidthPx,
    height: contentHeightPx,
    // translate(-50%,-50%) turns the center-based left/top into the box's
    // actual top-left rendering position; rotation is applied on the same
    // transform so it pivots around the box's own center.
    transform: `translate(-50%, -50%)${transform.rotation ? ` rotate(${transform.rotation}deg)` : ''}`,
    // Deliberately NOT clipped: the scale math above already sizes the
    // composition to exactly fill (or, when aspect-locked, exactly fit
    // inside) this box, so no real card/text/icon should ever need
    // clipping. Left open so a decorative shadow/glow can bleed a few px,
    // per the "small shadows may extend visually" allowance.
    overflow: 'visible',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }

  const innerStyle: CSSProperties = {
    width: intrinsicWidth,
    height: intrinsicHeight,
    flexShrink: 0,
    transform: `scale(${scaleX}, ${scaleY})`,
    transformOrigin: 'center center'
  }

  return (
    <div className={className} style={outerStyle} data-scene-id={dataSceneId}>
      <div style={innerStyle}>{children}</div>
    </div>
  )
}
