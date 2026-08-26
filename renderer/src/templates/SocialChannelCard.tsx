import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, getStaggeredItemProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { TemplateIcon, resolveTemplateIconId } from './templateIcons'
import { DesignCanvas } from './DesignCanvas'
import { isCompactAspectRatio } from './designScale'
import type { SceneContentItem } from '@shared/project'

const ROW_COUNT = 4
const DEFAULT_COLORS = ['#1687ff', '#8b42ff', '#18d77b', '#f2ad18']
const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'social-0', label: '@creator.km', description: 'Follow', iconId: 'social', color: '#1687ff' },
  { id: 'social-1', label: 'Creator Channel', description: 'Subscribe', iconId: 'message', color: '#8b42ff' },
  { id: 'social-2', label: 'Community Group', description: 'Join', iconId: 'social', color: '#18d77b' }
]

/** Also used by ScenePropertiesPanel to initialize `content.items`. */
export function deriveSocialItems(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, ROW_COUNT)
  return DEFAULT_ITEMS
}

/** A presenter-overlay profile card -- avatar/name/subtitle plus up to four
 * social/channel rows (platform icon, name, action pill). An internal video
 * graphic, deliberately not a mockup of any real app's UI. */
export function SocialChannelCard({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const items = deriveSocialItems(scene)
  const name = scene.content?.title ?? scene.visualText
  const subtitle = scene.content?.value ?? scene.reason
  const avatarIconId = resolveTemplateIconId(scene.icon?.iconId) ?? 'person'

  const options = resolveMotionOptions(scene, 'gentle')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const profileP = remap(enter, 0, 0.28)
  const rowsPhaseStart = 0.22 * options.enterDuration
  // Hold phase: the first (primary) call-to-action pill gets a restrained glow pulse.
  const ctaPulse = frame.loopEnabled ? pulse(frame.holdTime, 0.5 * frame.loopSpeed, 1 - 0.25 * frame.intensity, 1) : 1

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div
        data-scene-id={scene.id}
        className={`scene-graphic-social-card${compact ? ' scene-graphic-social-card-compact' : ''}${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle }}
      >
        <div className="scene-social-card-panel" style={{ borderColor: `${accent}55` }}>
          <div className="scene-social-card-profile" style={{ opacity: profileP, transform: `translateY(${(1 - profileP) * 12}px)` }}>
            <span className="scene-social-card-avatar" style={{ borderColor: accent, background: primary }}>
              <TemplateIcon id={avatarIconId} size={22} color="#fff" />
            </span>
            <div className="scene-social-card-profile-text">
              <span className="scene-social-card-name" lang="km">
                {name}
              </span>
              {subtitle && (
                <span className="scene-social-card-subtitle" lang="km">
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          <div className="scene-social-card-rows">
            {items.map((item, i) => {
              const rowP = getStaggeredItemProgress({
                localTime: frame.localTime,
                phaseStart: rowsPhaseStart,
                itemIndex: i,
                itemCount: items.length,
                staggerDelay: options.staggerDelay,
                enterDuration: options.enterDuration,
                intensity: frame.intensity,
                easing: scene.animationEasing
              })
              const pillP = remap(rowP, 0.55, 1)
              const color = item.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]
              return (
                <div key={item.id} className="scene-social-card-row" style={{ opacity: rowP, transform: `translateX(${(1 - rowP) * -14}px)` }}>
                  <span className="scene-social-card-row-icon" style={{ background: `${color}26`, color }}>
                    <SceneIconGlyph icon={{ iconId: resolveTemplateIconId(item.iconId) ?? 'social', color }} defaultColor={color} defaultSize={16} />
                  </span>
                  <span className="scene-social-card-row-name" lang="km">
                    {item.label}
                  </span>
                  {item.description && (
                    <span
                      className="scene-social-card-row-action"
                      style={{
                        opacity: pillP,
                        background: color,
                        boxShadow: i === 0 ? `0 0 ${10 * ctaPulse}px ${color}88` : undefined,
                        transform: i === 0 ? `scale(${1 + 0.03 * (ctaPulse - (1 - 0.25 * frame.intensity))})` : undefined
                      }}
                    >
                      {item.description}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </DesignCanvas>
  )
}
