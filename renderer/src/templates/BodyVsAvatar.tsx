import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, hexToRgba } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'

const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'body-original', label: 'Original Body', description: 'Ancient God cultivation, physical power', value: 'ORIGINAL BODY', color: '#18d77b' },
  { id: 'body-avatar', label: 'Cultivation Avatar', description: 'Dao cultivation, origin soul and spells', value: 'CULTIVATION AVATAR', color: '#ffb020' }
]

export const INTRINSIC_SIZE = { width: 1500, height: 320 }
export const INTRINSIC_SIZE_COMPACT = { width: 640, height: 640 }

export function deriveBodyAvatarSides(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, 2)
  return DEFAULT_ITEMS
}

/** Visualization family C -- two equally-weighted cards (e.g. Original Body
 * / Cultivation Avatar) joined by a center connector marking the same
 * underlying identity. Deliberately symmetric, unlike Cause and Effect Flow
 * -- neither side gets an arrowhead or is visually implied to be more
 * "real" than the other; the center badge is the only thing that reads as
 * primary. */
export function BodyVsAvatar({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const sides = deriveBodyAvatarSides(scene)
  const left = sides[0]
  const right = sides[1]
  const centerLabel = scene.content?.value ?? scene.content?.title

  const options = resolveMotionOptions(scene, 'gentle')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const leftP = remap(enter, 0, 0.35)
  const centerP = remap(enter, 0.2, 0.55)
  const rightP = remap(enter, 0.4, 0.75)

  const leftColor = left?.color ?? accent
  const rightColor = right?.color ?? accent

  const composition = (
    <div className={`scene-graphic-flow scene-graphic-body-avatar${compact ? ' scene-graphic-flow-compact' : ''}`}>
      <div className="scene-flow-main">
        {left && (
          <div
            className="scene-flow-node"
            style={{ opacity: leftP, transform: `translateY(${(1 - leftP) * 14}px)`, borderColor: `${leftColor}77`, background: hexToRgba(leftColor, 0.14) }}
          >
            {left.value && (
              <span className="scene-flow-node-eyebrow" style={{ color: leftColor }}>
                {left.value}
              </span>
            )}
            <SceneIconGlyph icon={{ iconId: left.iconId, color: leftColor }} defaultColor={leftColor} defaultSize={24} />
            <span className="scene-flow-node-title" lang="km">
              {left.label}
            </span>
            {left.description && (
              <span className="scene-flow-node-subtitle" lang="km">
                {left.description}
              </span>
            )}
          </div>
        )}

        <span className="scene-flow-connector scene-body-avatar-connector" style={{ opacity: centerP }}>
          <span className="scene-flow-connector-line" style={{ transform: `scaleX(${centerP})`, background: accent }} />
          <span className="scene-body-avatar-badge" style={{ borderColor: accent, transform: `translate(-50%, -50%) scale(${0.7 + 0.3 * centerP})` }}>
            {centerLabel && (
              <span className="scene-body-avatar-badge-text" lang="km">
                {centerLabel}
              </span>
            )}
          </span>
        </span>

        {right && (
          <div
            className="scene-flow-node"
            style={{ opacity: rightP, transform: `translateY(${(1 - rightP) * 14}px)`, borderColor: `${rightColor}77`, background: hexToRgba(rightColor, 0.14) }}
          >
            {right.value && (
              <span className="scene-flow-node-eyebrow" style={{ color: rightColor }}>
                {right.value}
              </span>
            )}
            <SceneIconGlyph icon={{ iconId: right.iconId, color: rightColor }} defaultColor={rightColor} defaultSize={24} />
            <span className="scene-flow-node-title" lang="km">
              {right.label}
            </span>
            {right.description && (
              <span className="scene-flow-node-subtitle" lang="km">
                {right.description}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )

  const intrinsic = compact ? INTRINSIC_SIZE_COMPACT : INTRINSIC_SIZE

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={centerP} defaultMode="transparent" />}

        {isFullFrame ? (
          <SceneContentFrame
            transform={resolveEffectiveContentTransform(scene, scene.templateId, brand.defaultAspectRatio)}
            aspectRatio={brand.defaultAspectRatio}
            intrinsicWidth={intrinsic.width}
            intrinsicHeight={intrinsic.height}
            dataSceneId={scene.id}
          >
            {composition}
          </SceneContentFrame>
        ) : (
          <div
            data-scene-id={scene.id}
            className={positionStyle ? 'scene-graphic-fill' : undefined}
            style={{ position: 'absolute', ...(positionStyle ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }) }}
          >
            {composition}
          </div>
        )}
      </div>
    </DesignCanvas>
  )
}
