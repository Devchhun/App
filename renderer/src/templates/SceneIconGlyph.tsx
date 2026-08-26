import type { CSSProperties } from 'react'
import type { SceneIcon } from '@shared/templates'
import { TemplateIcon, resolveTemplateIconId } from './templateIcons'

/** Renders a scene's configured single/avatar icon (Properties > Design >
 * Icon), applying color/size/opacity/rotation/background. Returns null when
 * no icon is configured or the stored id doesn't resolve (unknown/stale id
 * from an older or hand-edited project file) -- callers render their
 * existing default glyph in that case instead of crashing. */
export function SceneIconGlyph({
  icon,
  defaultColor = '#ffffff',
  defaultSize = 20,
  className
}: {
  icon?: SceneIcon
  defaultColor?: string
  defaultSize?: number
  className?: string
}): JSX.Element | null {
  const id = resolveTemplateIconId(icon?.iconId)
  if (!id) return null

  const size = icon?.size ?? defaultSize
  const color = icon?.color ?? defaultColor
  const opacity = icon?.opacity !== undefined ? Math.max(0, Math.min(100, icon.opacity)) / 100 : 1

  const style: CSSProperties = {
    opacity,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: icon?.vAlign === 'top' ? 'flex-start' : icon?.vAlign === 'bottom' ? 'flex-end' : 'center',
    order: icon?.hAlign === 'right' ? 2 : 0
  }
  if (icon?.rotation) style.transform = `rotate(${icon.rotation}deg)`
  if (icon?.backgroundShape && icon.backgroundShape !== 'none') {
    style.background = icon.backgroundColor ?? 'rgba(255,255,255,0.14)'
    style.borderRadius = icon.backgroundShape === 'circle' ? 999 : (icon.backgroundRadius ?? 6)
    style.width = size + 14
    style.height = size + 14
  }

  return (
    <span className={className ? `scene-icon-glyph ${className}` : 'scene-icon-glyph'} style={style}>
      <TemplateIcon id={id} size={size} color={color} />
    </span>
  )
}
