import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, hexToRgba } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, getStaggeredItemProgress } from './motion'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneIconGlyph } from './SceneIconGlyph'
import { resolveTemplateIconId } from './templateIcons'
import { DesignCanvas } from './DesignCanvas'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'
import type { TemplateIconId } from '@shared/templates'

const DEVICE_COUNT = 4
// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this to fit whatever box the selection handles are dragged to.
const INTRINSIC_SIZE = { width: 1520, height: 680 }
const INTRINSIC_SIZE_COMPACT = { width: 900, height: 900 }
const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'device-0', label: 'iPhone', iconId: 'device', color: '#34e5c2' },
  { id: 'device-1', label: 'Mac', iconId: 'chip', color: '#ff9d42' },
  { id: 'device-2', label: 'Windows', iconId: 'chip', color: '#4da3ff' },
  { id: 'device-3', label: 'Android', iconId: 'device', color: '#a8e05f' }
]

/** Also used by ScenePropertiesPanel to initialize `content.items`. */
export function deriveDeviceItems(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, DEVICE_COUNT)
  return DEFAULT_ITEMS
}

type DeviceKind = 'phone' | 'laptop'

function inferDeviceKind(label: string): DeviceKind {
  return /mac|windows|laptop|pc\b/i.test(label) ? 'laptop' : 'phone'
}

/** Resolves one device's display color/icon, falling back to that slot's
 * default device (not a blank glyph) when the stored icon id is missing or
 * unknown -- e.g. from a hand-edited or corrupted project file. Exported
 * standalone so this fallback behavior is unit-testable without rendering. */
export function resolveDeviceIconAndColor(item: SceneContentItem, index: number, accentFallback: string): { color: string; iconId: TemplateIconId } {
  const fallbackDevice = DEFAULT_ITEMS[index % DEFAULT_ITEMS.length]
  return {
    color: item.color ?? fallbackDevice.color ?? accentFallback,
    iconId: resolveTemplateIconId(item.iconId) ?? fallbackDevice.iconId ?? 'device'
  }
}

/** A device silhouette built purely from CSS/SVG (no imported screenshots or
 * brand logos -- a generic platform icon + label stands in for the logo). */
function DeviceFrame({ kind, color }: { kind: DeviceKind; color: string }): JSX.Element {
  if (kind === 'laptop') {
    return (
      <svg className="scene-device-frame-svg scene-device-frame-svg-laptop" viewBox="0 0 220 160" width="374" height="272">
        <rect x="14" y="6" width="192" height="122" rx="10" fill="none" stroke={color} strokeWidth="6" />
        <rect x="24" y="16" width="172" height="102" fill={hexToRgba(color, 0.16)} />
        <path d="M4 150 L34 132 L186 132 L216 150 Z" fill="none" stroke={color} strokeWidth="6" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg className="scene-device-frame-svg scene-device-frame-svg-phone" viewBox="0 0 120 210" width="204" height="357">
      <rect x="6" y="6" width="108" height="198" rx="22" fill="none" stroke={color} strokeWidth="6" />
      <rect x="18" y="24" width="84" height="150" fill={hexToRgba(color, 0.16)} />
      <circle cx="60" cy="192" r="5" fill={color} />
    </svg>
  )
}

/** Full-frame lineup of four device silhouettes with per-device color, icon,
 * and label -- for supported-platform / availability scenes. The BACKGROUND
 * (default: transparent, so the source video stays visible) spans the full
 * design canvas; heading/devices/CTA are a separate, independently
 * selectable, movable, and resizable FOREGROUND group (scene.contentTransform). */
export function DeviceCompatibilityLineup({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const items = deriveDeviceItems(scene)
  const heading = scene.content?.title ?? scene.visualText
  const cta = scene.content?.cta ?? ''
  const secondaryGlowColor = '#8b3f6e'

  const options = resolveMotionOptions(scene, 'dynamic')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const glowP = remap(enter, 0, 0.3)
  const headingP = remap(enter, 0, 0.22)
  const devicesPhaseStart = 0.16 * options.enterDuration
  const ctaP = remap(enter, 0.8, 1)

  const overlayPositionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const intrinsic = compact ? INTRINSIC_SIZE_COMPACT : INTRINSIC_SIZE

  const composition = (
    <div className={`scene-device-lineup-content${compact ? ' scene-device-lineup-content-compact' : ''}`}>
      {!isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />}

      <span className="scene-device-lineup-heading" lang="km" style={{ opacity: headingP, transform: `translateY(${(1 - headingP) * 14}px)` }}>
        {heading}
      </span>

      <div className="scene-device-lineup-row">
        {items.map((item, i) => {
          const deviceP = getStaggeredItemProgress({
            localTime: frame.localTime,
            phaseStart: devicesPhaseStart,
            itemIndex: i,
            itemCount: DEVICE_COUNT,
            staggerDelay: options.staggerDelay,
            enterDuration: options.enterDuration,
            intensity: frame.intensity,
            easing: scene.animationEasing
          })
          const iconP = remap(deviceP, 0.3, 1)
          const labelP = remap(deviceP, 0.6, 1)
          const { color, iconId } = resolveDeviceIconAndColor(item, i, accent)
          const kind = inferDeviceKind(item.label)
          // Hold phase: each device's glow breathes subtly, staggered per device so they don't pulse in unison.
          const glowBreathe = frame.loopEnabled && deviceP >= 1 ? pulse(frame.holdTime + i * 0.6, 0.4 * frame.loopSpeed, 0.75, 1) : 1
          return (
            <div
              key={item.id}
              className="scene-device-lineup-item"
              style={{ opacity: deviceP, transform: `translateY(${(1 - deviceP) * 26}px) scale(${0.88 + 0.12 * deviceP})` }}
            >
              <span className="scene-device-lineup-glow" style={{ background: hexToRgba(color, 0.4 * deviceP * glowBreathe) }} />
              <DeviceFrame kind={kind} color={color} />
              <span className="scene-device-lineup-icon" style={{ opacity: iconP }}>
                <SceneIconGlyph icon={{ iconId, color }} defaultColor={color} defaultSize={38} />
              </span>
              <span className="scene-device-lineup-label" lang="km" style={{ opacity: labelP }}>
                {item.label}
              </span>
            </div>
          )
        })}
      </div>

      {cta && (
        <span className="scene-device-lineup-cta" lang="km" style={{ opacity: ctaP }}>
          {cta}
        </span>
      )}
    </div>
  )

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && (
          <>
            <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />
            {(scene.background?.mode ?? 'transparent') !== 'transparent' && (
              <div className="scene-device-lineup-glow-layer" style={{ opacity: glowP }}>
                <div
                  className="scene-device-lineup-glow-right"
                  style={{ background: `radial-gradient(circle at 88% 62%, ${hexToRgba(secondaryGlowColor, 0.32)}, transparent 58%)` }}
                />
              </div>
            )}
          </>
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
