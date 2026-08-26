import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, getStaggeredItemProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { resolveTemplateIconId } from './templateIcons'
import { DesignCanvas } from './DesignCanvas'
import { isCompactAspectRatio } from './designScale'
import type { SceneContentItem } from '@shared/project'

const PILL_COUNT = 4
const DEFAULT_COLORS = ['#1687ff', '#8b42ff', '#18d77b', '#f2ad18']
const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'pill-0', label: 'Fast setup', iconId: 'check', color: '#1687ff' },
  { id: 'pill-1', label: 'Secure by default', iconId: 'security', color: '#8b42ff' },
  { id: 'pill-2', label: 'Works everywhere', iconId: 'device', color: '#18d77b' }
]

/** Also used by ScenePropertiesPanel to initialize `content.items`. */
export function deriveBenefitItems(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, PILL_COUNT)
  return DEFAULT_ITEMS
}

/** A title with an accent phrase above three or four rounded benefit pills.
 * Transparent by default -- no full-screen card, just the content group. */
export function FeatureBenefitsPills({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const items = deriveBenefitItems(scene)
  const eyebrow = scene.content?.eyebrow ?? ''
  const title = scene.content?.title ?? scene.visualText
  const accentPhrase = scene.content?.value ?? ''

  const options = resolveMotionOptions(scene, 'dynamic')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const eyebrowP = remap(enter, 0, 0.2)
  const titleP = remap(enter, 0.1, 0.5)
  const pillsPhaseStart = 0.45 * options.enterDuration
  // "No continuous movement unless Loop is enabled" -- pills sit still once
  // revealed by default; a restrained border pulse only when the scene opts in.
  const pillPulse = frame.loopEnabled ? pulse(frame.holdTime, 0.45 * frame.loopSpeed, 1, 1 + 0.15 * frame.intensity) : 1

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div
        data-scene-id={scene.id}
        className={`scene-graphic-benefits${compact ? ' scene-graphic-benefits-compact' : ''}${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), textAlign: 'center', ...positionStyle }}
      >
        {eyebrow && (
          <span className="scene-benefits-eyebrow" style={{ opacity: eyebrowP, color: accent }}>
            {eyebrow}
          </span>
        )}
        <span className="scene-benefits-mask" style={{ clipPath: `inset(${(1 - titleP) * 100}% 0 0 0)` }}>
          <span className="scene-benefits-title" lang="km">
            {title}
            {accentPhrase && (
              <span className="scene-benefits-title-accent" style={{ color: accent }}>
                {' '}
                {accentPhrase}
              </span>
            )}
          </span>
        </span>

        <div className="scene-benefits-pills">
          {items.map((item, i) => {
            const pillP = getStaggeredItemProgress({
              localTime: frame.localTime,
              phaseStart: pillsPhaseStart,
              itemIndex: i,
              itemCount: items.length,
              staggerDelay: options.staggerDelay,
              enterDuration: options.enterDuration,
              intensity: frame.intensity,
              easing: scene.animationEasing
            })
            const iconP = remap(pillP, 0.4, 1) // icon pops in after its pill has mostly arrived
            const iconOvershoot = Math.sin(Math.min(iconP, 1) * Math.PI) * 0.25
            const color = item.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]
            return (
              <span
                key={item.id}
                className="scene-benefits-pill"
                style={{
                  opacity: pillP,
                  transform: `translateY(${(1 - pillP) * 14}px) scale(${(0.9 + 0.1 * pillP) * (pillP >= 1 ? pillPulse : 1)})`,
                  borderColor: `${color}66`
                }}
              >
                <span className="scene-benefits-pill-icon" style={{ color, opacity: iconP, transform: `scale(${0.6 + 0.4 * iconP + iconOvershoot})` }}>
                  <SceneIconGlyph icon={{ iconId: resolveTemplateIconId(item.iconId) ?? 'check', color }} defaultColor={color} defaultSize={16} />
                </span>
                <span className="scene-benefits-pill-label" lang="km">
                  {item.label}
                </span>
              </span>
            )
          })}
        </div>
      </div>
    </DesignCanvas>
  )
}
