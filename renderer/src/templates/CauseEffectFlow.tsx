import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, hexToRgba } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, loopProgress, getStaggeredItemProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { resolveTemplateIconId } from './templateIcons'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'

const NODE_COUNT = 4
const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'flow-cause', label: 'Weak Password', description: 'Reused across sites', value: 'CAUSE', iconId: 'warning', color: '#ff5364' },
  { id: 'flow-effect', label: 'Account Takeover', description: 'Session stolen', value: 'EFFECT', iconId: 'security', color: '#1687ff' }
]

// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this uniformly/independently to fit whatever box the user drags the
// selection handles to. The row layout (16:9) is wider than it is tall; the
// stacked compact layout (9:16/1:1) is the reverse.
export const INTRINSIC_SIZE = { width: 1500, height: 300 }
export const INTRINSIC_SIZE_COMPACT = { width: 640, height: 620 }

/** Also used by ScenePropertiesPanel: items[0] is the cause node, items[1]
 * the effect node, any further items are supporting nodes. */
export function deriveFlowNodes(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, NODE_COUNT)
  return DEFAULT_ITEMS
}

/** Two connected cause/effect nodes with a drawing connector between them,
 * plus optional supporting nodes. For cause, effect, problem/solution, and
 * comparison scenes. Full-frame by default: the BACKGROUND (default:
 * transparent, so the source video stays visible) spans the full design
 * canvas, while the cause -> connector -> effect composition is a separate,
 * independently selectable/movable/resizable FOREGROUND group
 * (scene.contentTransform, via SceneContentFrame) -- same architecture as
 * Tech Title Scene / Device Compatibility Lineup, which is what makes
 * dragging/resizing this template's on-canvas selection box actually move
 * and scale the real cause/connector/effect composition instead of just an
 * outer box the fixed-size cards ignore. */
export function CauseEffectFlow({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const nodes = deriveFlowNodes(scene)
  const cause = nodes[0]
  const effect = nodes[1]
  const supporting = nodes.slice(2)

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const glowP = remap(enter, 0, 0.3)
  const causeP = remap(enter, 0, 0.3)
  const connectorP = remap(enter, 0.22, 0.55)
  const effectP = remap(enter, 0.5, 0.8)
  const supportPhaseStart = 0.72 * options.enterDuration
  // Hold phase: a small dot travels the connector once it has fully drawn.
  const flowT = frame.loopEnabled && connectorP >= 1 ? loopProgress(frame.holdTime, frame.loopSpeed, 1.8) : null

  const causeColor = cause?.color ?? '#ff5364'
  const effectColor = effect?.color ?? accent

  const composition = (
    <div className={`scene-graphic-flow${compact ? ' scene-graphic-flow-compact' : ''}`}>
      <div className="scene-flow-main">
        {cause && (
          <div
            className="scene-flow-node scene-flow-node-cause"
            style={{ opacity: causeP, transform: `translateY(${(1 - causeP) * 14}px)`, borderColor: `${causeColor}77`, background: hexToRgba(causeColor, 0.14) }}
          >
            {cause.value && (
              <span className="scene-flow-node-eyebrow" style={{ color: causeColor }}>
                {cause.value}
              </span>
            )}
            <span className="scene-flow-node-icon" style={{ color: causeColor }}>
              <SceneIconGlyph icon={{ iconId: resolveTemplateIconId(cause.iconId) ?? 'warning', color: causeColor }} defaultColor={causeColor} defaultSize={24} />
            </span>
            <span className="scene-flow-node-title" lang="km">
              {cause.label}
            </span>
            {cause.description && (
              <span className="scene-flow-node-subtitle" lang="km">
                {cause.description}
              </span>
            )}
          </div>
        )}

        <span className="scene-flow-connector" style={{ opacity: connectorP }}>
          <span className="scene-flow-connector-line" style={{ transform: `scaleX(${connectorP})`, background: accent }} />
          <span className="scene-flow-connector-arrow" style={{ opacity: remap(connectorP, 0.75, 1), borderLeftColor: accent }} />
          {flowT !== null && <span className="scene-flow-connector-dot" style={{ left: `${flowT * 100}%`, background: accent }} />}
        </span>

        {effect && (
          <div
            className="scene-flow-node scene-flow-node-effect"
            style={{ opacity: effectP, transform: `translateY(${(1 - effectP) * 14}px)`, borderColor: `${effectColor}77`, background: hexToRgba(effectColor, 0.14) }}
          >
            {effect.value && (
              <span className="scene-flow-node-eyebrow" style={{ color: effectColor }}>
                {effect.value}
              </span>
            )}
            <span className="scene-flow-node-icon" style={{ color: effectColor }}>
              <SceneIconGlyph icon={{ iconId: resolveTemplateIconId(effect.iconId) ?? 'security', color: effectColor }} defaultColor={effectColor} defaultSize={24} />
            </span>
            <span className="scene-flow-node-title" lang="km">
              {effect.label}
            </span>
            {effect.description && (
              <span className="scene-flow-node-subtitle" lang="km">
                {effect.description}
              </span>
            )}
          </div>
        )}
      </div>

      {supporting.length > 0 && (
        <div className="scene-flow-support-row">
          {supporting.map((node, i) => {
            const nodeP = getStaggeredItemProgress({
              localTime: frame.localTime,
              phaseStart: supportPhaseStart,
              itemIndex: i,
              itemCount: supporting.length,
              staggerDelay: options.staggerDelay,
              enterDuration: options.enterDuration,
              intensity: frame.intensity,
              easing: scene.animationEasing
            })
            const color = node.color ?? accent
            return (
              <span
                key={node.id}
                className="scene-flow-support-node"
                style={{ opacity: nodeP, transform: `translateY(${(1 - nodeP) * 10}px)`, borderColor: `${color}55` }}
              >
                <SceneIconGlyph icon={{ iconId: node.iconId, color }} defaultColor={color} defaultSize={14} />
                <span lang="km">{node.label}</span>
              </span>
            )
          })}
        </div>
      )}
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
            style={{ position: 'absolute', ...(positionStyle ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }) }}
          >
            {composition}
          </div>
        )}
      </div>
    </DesignCanvas>
  )
}
