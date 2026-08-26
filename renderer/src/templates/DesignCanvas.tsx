import type { CSSProperties, ReactNode } from 'react'
import { computeDesignFit, type AnyAspectRatio } from './designScale'

/** Renders `children` inside a fixed logical design canvas (1920x1080 for
 * 16:9, etc -- see shared/templates.ts CANVAS_SIZE_BY_ASPECT) uniformly
 * contain-fit scaled to the actual measured stage, matching exactly what
 * `computeDesignFit` computes (SceneSelectionOverlay's foreground handles use
 * the same function against the same inputs, so the rendered content and its
 * selection outline can never drift apart). Every cinematic template authors
 * font sizes, gaps, and paddings once, in design-space pixels, instead of
 * guessing values against the small live Preview stage. */
export function DesignCanvas({
  aspectRatio,
  stageSize,
  className,
  children
}: {
  aspectRatio: AnyAspectRatio
  stageSize: { width: number; height: number } | null
  className?: string
  children: ReactNode
}): JSX.Element {
  const fit = computeDesignFit(stageSize?.width ?? 0, stageSize?.height ?? 0, aspectRatio)

  const outerStyle: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden' }
  const innerStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: fit.designWidth,
    height: fit.designHeight,
    transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
    transformOrigin: 'top left'
  }

  return (
    <div style={outerStyle}>
      <div className={className} style={innerStyle}>
        {children}
      </div>
    </div>
  )
}
