import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveBoxStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { SceneIconGlyph } from './SceneIconGlyph'

export function LowerThird({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `translateX(${-30 * (1 - motion.enterProgress) + 30 * motion.exitProgress}px)`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-lower-third"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <span className="scene-graphic-accent-bar" style={{ background: accent }} />
      <div
        className={`scene-graphic-lower-third-box${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={resolveBoxStyle(scene, brand, primary)}
      >
        <SceneIconGlyph icon={scene.icon} defaultColor={accent} defaultSize={18} />
        <span lang="km" style={resolveTextStyle(scene)}>
          {scene.visualText}
        </span>
      </div>
    </div>
  )
}
