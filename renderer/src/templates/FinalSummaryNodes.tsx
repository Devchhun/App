import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, hexToRgba } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, getStaggeredItemProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'

const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'summary-1', label: "Wang Lin's life is real.", color: '#18d77b' },
  { id: 'summary-2', label: 'Both bodies are Wang Lin.', color: '#ffb020' },
  { id: 'summary-3', label: 'Lu Mo performed the Dao Dream simulations.', color: '#b45bff' }
]

export const INTRINSIC_SIZE = { width: 1400, height: 640 }
export const INTRINSIC_SIZE_COMPACT = { width: 640, height: 900 }

interface Point {
  x: number
  y: number
}

const CENTER_WIDE: Point = { x: 700, y: 560 }
const NODES_WIDE: Point[] = [
  { x: 250, y: 130 },
  { x: 700, y: 90 },
  { x: 1150, y: 130 }
]

const CENTER_COMPACT: Point = { x: 320, y: 820 }
const NODES_COMPACT: Point[] = [
  { x: 320, y: 150 },
  { x: 320, y: 400 },
  { x: 320, y: 650 }
]

function connectorGeometry(from: Point, to: Point): { length: number; angleDeg: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return { length: Math.hypot(dx, dy), angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI }
}

export function deriveSummaryNodes(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, 3)
  return DEFAULT_ITEMS
}

/** Visualization family L -- three connected conclusion nodes converging on
 * one central identity, closing a connected story sequence. Each node's
 * connector line is drawn (geometrically, toward the shared center point)
 * as it enters, reusing the icon/color the same entity carried in earlier
 * scenes so the final summary visually "reuses learned colors" rather than
 * introducing new ones. */
export function FinalSummaryNodes({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const nodes = deriveSummaryNodes(scene)
  const centerLabel = scene.content?.title ?? scene.visualText

  const center = compact ? CENTER_COMPACT : CENTER_WIDE
  const anchors = compact ? NODES_COMPACT : NODES_WIDE

  const options = resolveMotionOptions(scene, 'cinematic')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const centerP = remap(frame.enterProgress, 0, 0.3)

  const composition = (
    <div className="scene-graphic-final-summary" style={{ width: compact ? INTRINSIC_SIZE_COMPACT.width : INTRINSIC_SIZE.width, height: compact ? INTRINSIC_SIZE_COMPACT.height : INTRINSIC_SIZE.height }}>
      {nodes.map((node, i) => {
        const anchor = anchors[i] ?? anchors[anchors.length - 1]
        const color = node.color ?? accent
        const nodeP = getStaggeredItemProgress({
          localTime: frame.localTime,
          phaseStart: 0.15,
          itemIndex: i,
          itemCount: nodes.length,
          staggerDelay: options.staggerDelay,
          enterDuration: options.enterDuration,
          intensity: frame.intensity,
          easing: scene.animationEasing
        })
        const connectorP = remap(nodeP, 0.35, 1)
        const { length, angleDeg } = connectorGeometry(anchor, center)
        return (
          <div key={node.id}>
            <span
              className="scene-summary-connector"
              style={{
                left: anchor.x,
                top: anchor.y,
                width: length,
                background: color,
                opacity: connectorP,
                transform: `rotate(${angleDeg}deg) scaleX(${connectorP})`
              }}
            />
            <div
              className="scene-summary-node"
              style={{
                left: anchor.x,
                top: anchor.y,
                opacity: nodeP,
                transform: `translate(-50%, -50%) scale(${0.85 + 0.15 * nodeP})`,
                borderColor: `${color}77`,
                background: hexToRgba(color, 0.14)
              }}
            >
              <SceneIconGlyph icon={{ iconId: node.iconId, color }} defaultColor={color} defaultSize={18} />
              <span className="scene-summary-node-label" lang="km">
                {node.label}
              </span>
            </div>
          </div>
        )
      })}

      <div
        className="scene-summary-center"
        style={{ left: center.x, top: center.y, opacity: centerP, transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * centerP})`, borderColor: accent, background: hexToRgba(accent, 0.18) }}
      >
        <span className="scene-summary-center-label" lang="km">
          {centerLabel}
        </span>
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
