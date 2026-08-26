import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'

export const INTRINSIC_SIZE = { width: 620, height: 260 }

/** Visualization family J -- a compact evidence callout: a chapter/source
 * marker, a short paraphrased claim, and a connector toward the conclusion
 * it supports. Used when the transcript cites a specific chapter/source as
 * evidence for a claim. Deliberately overlay-first (compact) -- this is a
 * quick supporting callout in the visual rhythm, not a full diagram.
 * Renders only text present in scene content -- never invents a chapter
 * number or quotation itself. */
export function ChapterEvidenceCard({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = scene.fillColor ?? overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined

  const marker = scene.content?.eyebrow
  const claim = scene.content?.title ?? scene.content?.body ?? scene.visualText
  const status = scene.content?.value

  const options = resolveMotionOptions(scene, 'gentle')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const markerP = remap(enter, 0, 0.3)
  const claimP = remap(enter, 0.18, 0.55)
  const statusP = remap(enter, 0.45, 0.75)
  const connectorP = remap(enter, 0.55, 0.9)

  const composition = (
    <div className="scene-graphic-chapter-evidence">
      <div className="scene-evidence-marker-row" style={{ opacity: markerP }}>
        <SceneIconGlyph icon={{ iconId: scene.icon?.iconId ?? 'check', color: accent }} defaultColor={accent} defaultSize={18} />
        {marker && (
          <span className="scene-evidence-marker" style={{ color: accent, borderColor: `${accent}55` }}>
            {marker}
          </span>
        )}
      </div>
      <span className="scene-evidence-claim" lang="km" style={{ opacity: claimP, transform: `translateY(${(1 - claimP) * 8}px)` }}>
        {claim}
      </span>
      {status && (
        <span className="scene-evidence-status" style={{ opacity: statusP, background: `${accent}22`, color: accent, borderColor: `${accent}66` }}>
          {status}
        </span>
      )}
      <span className="scene-evidence-connector" style={{ opacity: connectorP }}>
        <span className="scene-evidence-connector-line" style={{ transform: `scaleX(${connectorP})`, background: accent }} />
      </span>
    </div>
  )

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={claimP} defaultMode="transparent" />}

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
