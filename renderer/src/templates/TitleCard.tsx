import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'

/** Large centered title, held on screen -- for introductions and section openers. */
export function TitleCard({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const title = scene.content?.title ?? scene.visualText
  const subtitle = scene.content?.subtitle
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `scale(${0.92 + 0.08 * motion.enterProgress - 0.04 * motion.exitProgress})`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-title-card"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div className={`scene-graphic-title-card-inner${positionStyle ? ' scene-graphic-fill' : ''}`}>
        <span className="scene-graphic-title-card-bar" style={{ background: accent }} />
        <span className="scene-graphic-title-card-title" lang="km" style={resolveTextStyle(scene)}>
          {title}
        </span>
        {subtitle && (
          <span className="scene-graphic-title-card-subtitle" lang="km">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  )
}
