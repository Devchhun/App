import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveBoxStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { SceneIconGlyph } from './SceneIconGlyph'

const DEFAULT_DANGER_COLOR = '#ef5a5a'

export function WarningAlert({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const dangerColor = overrides?.accentColor ?? DEFAULT_DANGER_COLOR
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `translateY(${-20 * (1 - motion.enterProgress) + 20 * motion.exitProgress}px)`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-warning"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div className={`scene-graphic-warning-box${positionStyle ? ' scene-graphic-fill' : ''}`} style={resolveBoxStyle(scene, brand, dangerColor)}>
        {scene.icon?.iconId ? (
          <SceneIconGlyph icon={scene.icon} defaultColor="#fff" defaultSize={18} />
        ) : (
          <span className="scene-graphic-warning-icon">⚠</span>
        )}
        <span lang="km" style={resolveTextStyle(scene)}>
          {scene.visualText}
        </span>
      </div>
    </div>
  )
}
