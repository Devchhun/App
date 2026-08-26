import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { TemplateIcon, resolveTemplateIconId } from './templateIcons'

/** A framed name/role card -- for introducing a person or organization. */
export function PersonCard({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const name = scene.content?.title ?? scene.visualText
  const role = scene.content?.subtitle ?? scene.reason
  const positionStyle = getPositionStyle(scene)
  const avatarIconId = resolveTemplateIconId(scene.icon?.iconId) ?? 'person'
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `translateX(${-24 * (1 - motion.enterProgress) + 24 * motion.exitProgress}px)`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-person"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div className={`scene-graphic-person-inner${positionStyle ? ' scene-graphic-fill' : ''}`}>
        <span className="scene-graphic-person-avatar" style={{ borderColor: accent, background: primary }}>
          <TemplateIcon id={avatarIconId} size={scene.icon?.size ?? 20} color={scene.icon?.color ?? '#fff'} />
        </span>
        <div className="scene-graphic-person-text">
          <span className="scene-graphic-person-name" lang="km" style={resolveTextStyle(scene)}>
            {name}
          </span>
          {role && (
            <span className="scene-graphic-person-role" lang="km">
              {role}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
