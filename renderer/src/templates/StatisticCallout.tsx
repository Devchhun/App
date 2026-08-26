import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveBoxStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { SceneIconGlyph } from './SceneIconGlyph'

export function StatisticCallout({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `scale(${0.85 + 0.15 * motion.enterProgress - 0.05 * motion.exitProgress})`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-statistic"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div
        className={`scene-graphic-statistic-box${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={{
          ...resolveBoxStyle(scene, brand, primary, accent),
          ...(positionStyle ? { transform: 'none' } : {})
        }}
      >
        <SceneIconGlyph icon={scene.icon} defaultColor={accent} defaultSize={22} className="scene-graphic-statistic-icon" />
        <span lang="km" style={resolveTextStyle(scene)}>
          {scene.visualText}
        </span>
      </div>
      {!positionStyle && <span className="scene-graphic-statistic-underline" style={{ background: accent }} />}
    </div>
  )
}
