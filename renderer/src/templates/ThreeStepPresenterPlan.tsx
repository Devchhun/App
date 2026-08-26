import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, getStaggeredItemProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { resolveTemplateIconId } from './templateIcons'
import { DesignCanvas } from './DesignCanvas'
import { isCompactAspectRatio } from './designScale'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'

const STEP_COUNT = 3
const DEFAULT_COLORS = ['#1687ff', '#8b42ff', '#18d77b']

/** Also used by ScenePropertiesPanel to initialize `content.items` (with
 * per-step icon/color slots) from a scene that hasn't set explicit content yet. */
export function deriveStepItems(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, STEP_COUNT)
  const parts = scene.visualText
    .split(/[,;\n]|(?:\s+and\s+)/i)
    .map((p) => p.trim())
    .filter(Boolean)
  const list = parts.length > 1 ? parts : [scene.visualText]
  return Array.from({ length: STEP_COUNT }, (_, i) => ({
    id: `${scene.id}-${i}`,
    label: list[i] ?? `Step ${i + 1}`,
    color: DEFAULT_COLORS[i]
  }))
}

/** A glass lower-third panel with three sequential step cards -- for plans,
 * workflows, and setup instructions delivered over a presenter video (the
 * source video stays fully visible above the panel, and the panel is capped
 * to the lower third of the frame so it never reaches up over a face). */
export function ThreeStepPresenterPlan({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  // presentationMode is still respected if a user explicitly overrides it
  // (e.g. to 'overlay'), but this template's own default stays presenter-overlay.
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const positionStyle = mode === 'full-frame' ? undefined : getPositionStyle(scene)
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const items = deriveStepItems(scene)
  const eyebrow = scene.content?.eyebrow ?? 'PLAN'

  const options = resolveMotionOptions(scene, 'gentle')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const panelP = remap(enter, 0, 0.3)
  const stepsPhaseStart = 0.26 * options.enterDuration

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div
        data-scene-id={scene.id}
        className={`scene-graphic-step-plan${compact ? ' scene-graphic-step-plan-compact' : ''}${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle }}
      >
        <div
          className="scene-step-plan-panel"
          style={{ opacity: panelP, transform: `translateY(${(1 - panelP) * 28}px)`, borderColor: `${accent}55` }}
        >
          <span className="scene-step-plan-eyebrow" lang="km" style={{ color: accent }}>
            {eyebrow}
          </span>
          <div className="scene-step-plan-cards">
            {items.map((item, i) => {
              const itemP = getStaggeredItemProgress({
                localTime: frame.localTime,
                phaseStart: stepsPhaseStart,
                itemIndex: i,
                itemCount: STEP_COUNT,
                staggerDelay: options.staggerDelay,
                enterDuration: options.enterDuration,
                intensity: frame.intensity,
                easing: scene.animationEasing
              })
              const circleScale = 0.5 + 0.5 * itemP + Math.sin(Math.min(itemP, 1) * Math.PI) * 0.14
              const textP = remap(itemP, 0.35, 1)
              const color = item.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]
              // Hold phase: a very restrained glow breathe once the circle has popped in.
              const circleGlow = frame.loopEnabled && itemP >= 1 ? pulse(frame.holdTime + i * 0.5, 0.35 * frame.loopSpeed, 0.6, 1) : 0
              return (
                <div key={item.id} className="scene-step-plan-card" style={{ opacity: itemP }}>
                  <span
                    className="scene-step-plan-number"
                    style={{ background: color, transform: `scale(${circleScale})`, boxShadow: circleGlow > 0 ? `0 0 ${12 * circleGlow}px ${color}` : undefined }}
                  >
                    {resolveTemplateIconId(item.iconId) ? (
                      <SceneIconGlyph icon={{ iconId: item.iconId }} defaultColor="#fff" defaultSize={20} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="scene-step-plan-text" style={{ opacity: textP, transform: `translateY(${(1 - textP) * 8}px)` }}>
                    <span className="scene-step-plan-title" lang="km">
                      {item.label}
                    </span>
                    {item.description && (
                      <span className="scene-step-plan-subtitle" lang="km">
                        {item.description}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </DesignCanvas>
  )
}
