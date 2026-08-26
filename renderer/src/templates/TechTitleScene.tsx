import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, deterministicFloat, getStaggeredItemProgress } from './motion'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'

// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this to fit whatever box the selection handles are dragged to.
const INTRINSIC_SIZE = { width: 1100, height: 520 }
const INTRINSIC_SIZE_COMPACT = { width: 900, height: 560 }

/** Full-frame cinematic chapter title. The BACKGROUND (default: a dark
 * gradient + glow, but Transparent is selectable so the source video stays
 * visible) always spans the full design canvas; the title/eyebrow/accent
 * FOREGROUND is a separate, independently selectable/movable/resizable group
 * (via scene.contentTransform, 8 handles, aspect-lock optional). */
export function TechTitleScene({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = scene.icon?.color ?? overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)

  const eyebrow = scene.content?.eyebrow ?? ''
  const title = scene.content?.title ?? scene.visualText
  const accentPhrase = scene.content?.value ?? ''

  const options = resolveMotionOptions(scene, 'cinematic')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const glowP = remap(enter, 0, 0.4)
  // The eyebrow/title/accent/icon reveal is a 4-step sequence (icon, eyebrow,
  // title, accent phrase) whose start offsets are driven by staggerDelay --
  // each element's own reveal speed still comes from its own itemDuration so
  // the title's slower masked reveal keeps its distinct character.
  const titleSequence = {
    localTime: frame.localTime,
    phaseStart: 0,
    itemCount: 4,
    staggerDelay: options.staggerDelay,
    enterDuration: options.enterDuration,
    intensity: frame.intensity,
    easing: scene.animationEasing
  }
  const iconP = getStaggeredItemProgress({ ...titleSequence, itemIndex: 0, itemDuration: 0.32 * options.enterDuration })
  const eyebrowP = getStaggeredItemProgress({ ...titleSequence, itemIndex: 1, itemDuration: 0.3 * options.enterDuration })
  const titleP = getStaggeredItemProgress({ ...titleSequence, itemIndex: 2, itemDuration: 0.44 * options.enterDuration })
  const accentP = getStaggeredItemProgress({ ...titleSequence, itemIndex: 3, itemDuration: 0.36 * options.enterDuration })
  // Hold phase: the background glow drifts very subtly rather than sitting
  // perfectly still -- a slow, bounded sine drift, never an unbounded loop.
  const glowDriftX = frame.loopEnabled ? deterministicFloat(frame.holdTime, 0.15 * frame.loopSpeed, 3 * frame.intensity) : 0
  const glowDriftY = frame.loopEnabled ? deterministicFloat(frame.holdTime, 0.11 * frame.loopSpeed, 2.4 * frame.intensity, 1.3) : 0

  const overlayPositionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const intrinsic = compact ? INTRINSIC_SIZE_COMPACT : INTRINSIC_SIZE

  const composition = (
    <div className={`scene-tech-title-content${compact ? ' scene-tech-title-content-compact' : ''}`} style={{ textAlign: 'center' }}>
      {!isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />}

      {scene.icon?.iconId && (
        <span className="scene-tech-title-icon-badge" style={{ opacity: iconP, transform: `scale(${0.6 + 0.4 * iconP})`, borderColor: accent }}>
          <SceneIconGlyph icon={scene.icon} defaultColor={accent} defaultSize={compact ? 30 : 36} />
        </span>
      )}

      {eyebrow && (
        <span className="scene-tech-title-eyebrow" style={{ opacity: eyebrowP, letterSpacing: `${0.5 + (1 - eyebrowP) * 4}px`, color: accent }}>
          {eyebrow}
        </span>
      )}

      <span className="scene-tech-title-mask" style={{ clipPath: `inset(${(1 - titleP) * 100}% 0 0 0)` }}>
        <span className="scene-tech-title-heading" lang="km" style={{ transform: `translateY(${(1 - titleP) * 16}px)` }}>
          {title}
        </span>
      </span>

      {accentPhrase && (
        <span className="scene-tech-title-accent" lang="km" style={{ opacity: accentP, transform: `translateY(${(1 - accentP) * 12}px)`, color: accent }}>
          {accentPhrase}
        </span>
      )}
    </div>
  )

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && (
          <div style={{ position: 'absolute', inset: 0, transform: `translate(${glowDriftX}px, ${glowDriftY}px)` }}>
            <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="gradient-overlay" />
          </div>
        )}

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
            className={overlayPositionStyle ? 'scene-graphic-fill' : undefined}
            style={{ position: 'absolute', ...(overlayPositionStyle ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }) }}
          >
            {composition}
          </div>
        )}
      </div>
    </DesignCanvas>
  )
}
