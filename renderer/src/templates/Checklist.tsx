import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveBoxStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { TemplateIcon, resolveTemplateIconId } from './templateIcons'
import type { SceneContentItem } from '@shared/project'

export const CHECKLIST_MAX_ITEMS = 4

/** Also used by ScenePropertiesPanel to initialize `content.items` (with
 * per-item icon slots) from a scene that hasn't set explicit content yet. */
export function deriveChecklistItems(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, CHECKLIST_MAX_ITEMS)
  const parts = scene.visualText
    .split(/[,;\n]|(?:\s+and\s+)/i)
    .map((p) => p.trim())
    .filter(Boolean)
  const list = parts.length > 1 ? parts : [scene.visualText]
  return list.slice(0, CHECKLIST_MAX_ITEMS).map((label, i) => ({ id: `${scene.id}-${i}`, label }))
}

/** A vertical checklist -- for list-type content. Each row stages in across
 * the scene's own enter window (a deterministic function of enterProgress,
 * not wall-clock time), so seeking to any timestamp gives the exact same result. */
export function Checklist({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const items = deriveChecklistItems(scene)
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `translateY(${16 * (1 - motion.enterProgress) - 16 * motion.exitProgress}px)`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-checklist"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div
        className={`scene-graphic-checklist-box${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={resolveBoxStyle(scene, brand, primary)}
      >
        {items.map((item, i) => {
          const itemEnter = Math.max(0, Math.min(1, motion.enterProgress * items.length - i))
          return (
            <div key={item.id} className="scene-graphic-checklist-row" style={{ opacity: itemEnter, transform: `translateX(${(1 - itemEnter) * 10}px)` }}>
              <span className="scene-graphic-checklist-check" style={{ background: accent }}>
                <TemplateIcon id={resolveTemplateIconId(item.iconId) ?? 'check'} size={11} color="#fff" />
              </span>
              <span className="scene-graphic-checklist-label" lang="km" style={resolveTextStyle(scene)}>
                {item.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
