import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, loopProgress, pulse } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'

export const INTRINSIC_SIZE = { width: 560, height: 460 }

/** Visualization family A -- a consistent character avatar centered on
 * screen with name, origin, and an identity badge (e.g. "The same Wang
 * Lin"), plus a small forward-extending timeline and a subtle animated
 * energy ring. Deliberately overlay-first (compact) by default -- the spec
 * warns against making every connected scene full-screen; this is the
 * "character card" beat in that visual rhythm, re-establishing one
 * recurring character's identity between the larger diagram scenes. */
export function CentralCharacterIdentity({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = scene.fillColor ?? overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined

  const name = scene.content?.title ?? scene.visualText
  const origin = scene.content?.value
  const badge = scene.content?.eyebrow

  const options = resolveMotionOptions(scene, 'gentle')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const avatarP = remap(enter, 0, 0.35)
  const nameP = remap(enter, 0.2, 0.5)
  const badgeP = remap(enter, 0.4, 0.65)
  const timelineP = remap(enter, 0.5, 0.9)
  const energy = frame.loopEnabled ? pulse(frame.holdTime, frame.loopSpeed, 0.7, 1) : 1
  const dotT = frame.loopEnabled ? loopProgress(frame.holdTime, frame.loopSpeed, 3.2) : 0

  const composition = (
    <div className="scene-graphic-central-identity">
      <div className="scene-central-ring" style={{ opacity: avatarP, borderColor: accent, boxShadow: `0 0 ${28 * energy}px ${accent}66` }}>
        <span className="scene-central-avatar" style={{ background: accent, transform: `scale(${0.85 + 0.15 * avatarP})` }}>
          <SceneIconGlyph icon={scene.icon} defaultColor="#fff" defaultSize={38} />
        </span>
      </div>
      <span className="scene-central-name" lang="km" style={{ opacity: nameP, transform: `translateY(${(1 - nameP) * 10}px)` }}>
        {name}
      </span>
      {origin && (
        <span className="scene-central-origin" lang="km" style={{ opacity: nameP }}>
          {origin}
        </span>
      )}
      {badge && (
        <span className="scene-central-badge" style={{ opacity: badgeP, borderColor: accent, color: accent, transform: `translateY(${(1 - badgeP) * 6}px)` }}>
          {badge}
        </span>
      )}
      <div className="scene-central-timeline" style={{ opacity: timelineP }}>
        <span className="scene-central-timeline-line" style={{ transform: `scaleX(${timelineP})`, background: accent }} />
        <span className="scene-central-timeline-dot" style={{ left: `${Math.min(96, dotT * 100)}%`, background: accent }} />
      </div>
    </div>
  )

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={avatarP} defaultMode="transparent" />}

        {isFullFrame ? (
          <SceneContentFrame
            transform={resolveEffectiveContentTransform(scene, scene.templateId, brand.defaultAspectRatio)}
            aspectRatio={brand.defaultAspectRatio}
            intrinsicWidth={INTRINSIC_SIZE.width}
            intrinsicHeight={INTRINSIC_SIZE.height}
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
