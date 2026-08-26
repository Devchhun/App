import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'

/** One short phrase blown up to fill the frame -- for a main claim or conclusion. */
export function KeywordHighlight({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `scale(${0.8 + 0.2 * motion.enterProgress - 0.08 * motion.exitProgress})`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-keyword"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div className={`scene-graphic-keyword-inner${positionStyle ? ' scene-graphic-fill' : ''}`}>
        <span className="scene-graphic-keyword-text" lang="km" style={resolveTextStyle(scene)}>
          {scene.visualText}
        </span>
        <span className="scene-graphic-keyword-underline" style={{ background: accent }} />
      </div>
    </div>
  )
}
