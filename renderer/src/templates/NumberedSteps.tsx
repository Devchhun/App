import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveBoxStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { SceneIconGlyph } from './SceneIconGlyph'

export function NumberedSteps({ scene, brand, motion, stepNumber }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `translateY(${16 * (1 - motion.enterProgress) - 16 * motion.exitProgress}px)`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-steps"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <span className="scene-graphic-steps-badge" style={{ background: accent }}>
        {scene.icon?.iconId ? <SceneIconGlyph icon={scene.icon} defaultColor="#fff" defaultSize={14} /> : (stepNumber ?? '•')}
      </span>
      <div className={`scene-graphic-steps-box${positionStyle ? ' scene-graphic-fill' : ''}`} style={resolveBoxStyle(scene, brand, primary)}>
        <span lang="km" style={resolveTextStyle(scene)}>
          {scene.visualText}
        </span>
      </div>
    </div>
  )
}
