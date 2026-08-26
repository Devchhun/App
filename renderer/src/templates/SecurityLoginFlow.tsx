import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, getStaggeredItemProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { resolveTemplateIconId } from './templateIcons'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'

const ROW_COUNT = 3
const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'login-0', label: 'Password', description: 'Entered', iconId: 'security', color: '#1687ff', status: 'complete' },
  { id: 'login-1', label: 'SMS Code', description: 'Sent to device', iconId: 'message', color: '#f2ad18', status: 'warning' },
  { id: 'login-2', label: 'Two-Step Verification', description: 'Blocked', iconId: 'warning', color: '#ff5364', status: 'blocked' }
]

const STATUS_COLOR: Record<string, string> = { complete: '#18d77b', blocked: '#ff5364', warning: '#f2ad18', default: '#74808d' }

// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this to fit whatever box the selection handles are dragged to. The
// row layout (device + rows side by side) is wide; the stacked compact
// layout (9:16/1:1) is tall instead.
const INTRINSIC_SIZE = { width: 680, height: 360 }
const INTRINSIC_SIZE_COMPACT = { width: 640, height: 700 }

/** Also used by ScenePropertiesPanel to initialize `content.items`. */
export function deriveLoginRows(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, ROW_COUNT)
  return DEFAULT_ITEMS
}

/** An editable login-device frame beside a sequence of security rows, each
 * with its own complete/blocked/warning state (blocked/warning rows show an
 * animated diagonal cross). Full-frame by default: the BACKGROUND (default:
 * transparent, so the source video stays visible) spans the full design
 * canvas, while the device+rows composition is a separate, independently
 * selectable/movable/resizable FOREGROUND group (scene.contentTransform, via
 * SceneContentFrame) -- same architecture as Cause and Effect Flow, which is
 * what makes dragging/resizing this template's selection box actually move
 * and scale the real device frame and rows instead of just an outer box the
 * fixed-size device/rows ignore. */
export function SecurityLoginFlow({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const rows = deriveLoginRows(scene)
  const eyebrow = scene.content?.eyebrow ?? ''
  const footer = scene.content?.cta ?? ''

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const glowP = remap(enter, 0, 0.3)
  const deviceP = remap(enter, 0, 0.26)
  const connectorP = remap(enter, 0.16, 0.32)
  const rowsPhaseStart = 0.2 * options.enterDuration
  const footerP = remap(enter, 0.82, 1)
  // Hold phase: warning/blocked row icons pulse gently to draw the eye.
  const warnPulse = frame.loopEnabled ? pulse(frame.holdTime, 0.9 * frame.loopSpeed, 1 - 0.3 * frame.intensity, 1) : 1

  const composition = (
    <div className={`scene-graphic-login-flow${compact ? ' scene-graphic-login-flow-compact' : ''}`}>
      <div className="scene-login-flow-device" style={{ opacity: deviceP, transform: `translateX(${(1 - deviceP) * -24}px)`, borderColor: accent }}>
        <span className="scene-login-flow-device-dot" />
        <span className="scene-login-flow-device-lock" style={{ color: accent }}>
          <SceneIconGlyph icon={{ iconId: 'security', color: accent }} defaultColor={accent} defaultSize={30} />
        </span>
      </div>

      <span className="scene-login-flow-connector" style={{ opacity: connectorP, transform: `scaleX(${connectorP})` }} />

      <div className="scene-login-flow-rows">
        {eyebrow && (
          <span className="scene-login-flow-eyebrow" style={{ color: accent }}>
            {eyebrow}
          </span>
        )}
        {rows.map((row, i) => {
          const rowP = getStaggeredItemProgress({
            localTime: frame.localTime,
            phaseStart: rowsPhaseStart,
            itemIndex: i,
            itemCount: rows.length,
            staggerDelay: options.staggerDelay,
            enterDuration: options.enterDuration,
            intensity: frame.intensity,
            easing: scene.animationEasing
          })
          const status = row.status ?? 'default'
          const color = row.color ?? STATUS_COLOR[status] ?? accent
          const markP = remap(rowP, 0.6, 1)
          return (
            <div
              key={row.id}
              className={`scene-login-flow-row scene-login-flow-row-${status}`}
              style={{ opacity: rowP, transform: `translateX(${(1 - rowP) * 16}px)` }}
            >
              <span className="scene-login-flow-row-number" style={{ borderColor: color, color }}>
                {i + 1}
              </span>
              <span
                className="scene-login-flow-row-icon"
                style={{ color, opacity: status === 'warning' || status === 'blocked' ? warnPulse : 1 }}
              >
                <SceneIconGlyph icon={{ iconId: resolveTemplateIconId(row.iconId) ?? 'security', color }} defaultColor={color} defaultSize={18} />
              </span>
              <span className="scene-login-flow-row-text">
                <span className="scene-login-flow-row-title" lang="km">
                  {row.label}
                </span>
                {row.description && (
                  <span className="scene-login-flow-row-subtitle" lang="km">
                    {row.description}
                  </span>
                )}
              </span>
              {(status === 'blocked' || status === 'warning') && (
                <span className="scene-login-flow-row-cross" style={{ opacity: markP, color }}>
                  <svg viewBox="0 0 20 20" width="16" height="16">
                    <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </span>
              )}
              {status === 'complete' && (
                <span className="scene-login-flow-row-check" style={{ opacity: markP, color }}>
                  <SceneIconGlyph icon={{ iconId: 'check', color }} defaultColor={color} defaultSize={16} />
                </span>
              )}
            </div>
          )
        })}
        {footer && (
          <span className="scene-login-flow-footer" style={{ opacity: footerP }}>
            {footer}
          </span>
        )}
      </div>
    </div>
  )

  const intrinsic = compact ? INTRINSIC_SIZE_COMPACT : INTRINSIC_SIZE

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />}

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
            style={{ position: 'absolute', ...(positionStyle ?? { left: '6%', top: '50%', transform: 'translateY(-50%)' }) }}
          >
            {composition}
          </div>
        )}
      </div>
    </DesignCanvas>
  )
}
