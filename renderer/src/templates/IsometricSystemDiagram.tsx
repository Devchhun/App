import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import {
  computeTemplateMotionFrame,
  resolveMotionOptions,
  lineDrawProgress,
  loopProgress,
  pulse,
  deterministicRotation,
  deterministicFloat,
  getStaggeredItemProgress
} from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { isCompactAspectRatio } from './designScale'
import type { SceneContentItem } from '@shared/project'

const LAYER_COUNT = 3
const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'iso-0', label: 'User Device', iconId: 'device', color: '#1687ff' },
  { id: 'iso-1', label: 'Security Gateway', iconId: 'security', color: '#f2ad18', status: 'warning' },
  { id: 'iso-2', label: 'Server', iconId: 'chip', color: '#18d77b' }
]

/** Also used by ScenePropertiesPanel to initialize `content.items`. Index 0
 * is the bottom platform layer, index 2 the top. */
export function deriveIsometricNodes(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, LAYER_COUNT)
  return DEFAULT_ITEMS
}

const PLATFORM_W = 220
const PLATFORM_H = 96
const LAYER_GAP = 116
const DIAMOND = `M ${PLATFORM_W / 2} 0 L ${PLATFORM_W} ${PLATFORM_H * 0.32} L ${PLATFORM_W / 2} ${PLATFORM_H * 0.64} L 0 ${PLATFORM_H * 0.32} Z`
const DIAMOND_PERIMETER = 2 * Math.hypot(PLATFORM_W / 2, PLATFORM_H * 0.32) * 2

/** Entrance timing (seconds, local to the scene) -- matches the requested
 * 2.2s choreography. Scaled by `enterDuration / 2.2` so a scene using a
 * shorter/longer enter window (preset or explicit override) still plays the
 * same relative sequence instead of clipping the tail phases. */
function phase(t0: number, t1: number, localTime: number, enterDuration: number): number {
  const scale = enterDuration / 2.2
  return lineDrawProgress(localTime, t0 * scale, t1 * scale)
}

/** Three isometric platform layers (SVG, real line-draw via stroke-dasharray)
 * with one configurable node each, a slowly rotating wheel, and data packets
 * travelling the connectors during the hold phase. A node with
 * status 'warning'/'blocked' pulses as a highlighted failure/attack point.
 * Every value here is a pure function of the scene's own motion frame --
 * never wall-clock time -- so seeking reproduces the exact same frame and
 * smooth playback comes from PreviewPlayer's per-frame currentTime driver. */
export function IsometricSystemDiagram({ scene, brand, motion, stageSize, currentTime }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const positionStyle = getPositionStyle(scene)
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const nodes = deriveIsometricNodes(scene)
  const eyebrow = scene.content?.eyebrow ?? ''
  const title = scene.content?.title ?? scene.visualText

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const { localTime, holdTime, exitProgress, intensity, loopEnabled, loopSpeed } = frame

  const scale = options.enterDuration / 2.2
  const glowP = phase(0, 0.35, localTime, options.enterDuration) * (1 - exitProgress)
  // Repeated-element groups (platforms, connectors, nodes, stair bars) each
  // start `options.staggerDelay` seconds after the previous one -- the single
  // source of "how far apart do sequential elements enter" for this diagram.
  // Reference sub-phase windows (draw/rise durations) stay tied to the
  // original 2.2s choreography, scaled by enterDuration, so the character of
  // each individual element's own reveal is unaffected by the stagger value.
  const staggerSeq = {
    localTime,
    staggerDelay: options.staggerDelay,
    enterDuration: options.enterDuration,
    intensity,
    easing: scene.animationEasing
  }
  const platformDraw = [0, 1, 2].map((i) =>
    getStaggeredItemProgress({ ...staggerSeq, phaseStart: 0.15 * scale, itemIndex: i, itemCount: LAYER_COUNT, itemDuration: 0.55 * scale })
  )
  const platformRise = [0, 1, 2].map((i) =>
    getStaggeredItemProgress({ ...staggerSeq, phaseStart: 0.15 * scale, itemIndex: i, itemCount: LAYER_COUNT, itemDuration: 0.4 * scale })
  )
  const connectorDraw = [0, 1].map((i) =>
    getStaggeredItemProgress({ ...staggerSeq, phaseStart: 1.0 * scale, itemIndex: i, itemCount: 2, itemDuration: 0.55 * scale })
  )
  const nodesPhaseStart = 1.2 * scale
  const stairsDraw = [0, 1, 2, 3].map((i) =>
    getStaggeredItemProgress({ ...staggerSeq, phaseStart: 1.45 * scale, itemIndex: i, itemCount: 4, itemDuration: 0.4 * scale })
  )
  const textP = phase(1.7, 2.2, localTime, options.enterDuration)

  const wheelAngle = loopEnabled ? deterministicRotation(holdTime, 18 * intensity) : 0
  const gridDrift = loopEnabled ? 0.06 * intensity * deterministicFloat(holdTime, 0.4, 1, 0.6) : 0

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div
        data-scene-id={scene.id}
        className={`scene-graphic-isometric${compact ? ' scene-graphic-isometric-compact' : ''}${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle }}
      >
        <div className="scene-isometric-text" style={{ opacity: textP, transform: `translateY(${(1 - textP) * 10}px)` }}>
          {eyebrow && (
            <span className="scene-isometric-eyebrow" style={{ color: accent }}>
              {eyebrow}
            </span>
          )}
          <span className="scene-isometric-title" lang="km">
            {title}
          </span>
        </div>

        <div className="scene-isometric-diagram">
          <div
            className="scene-isometric-glow"
            style={{ opacity: glowP * (0.55 + 0.45 * intensity), background: `radial-gradient(circle, ${accent}33, transparent 65%)` }}
          />

          <svg className="scene-isometric-svg" viewBox={`0 0 ${PLATFORM_W} ${PLATFORM_H + LAYER_GAP * 2 + 40}`} width={PLATFORM_W} height={PLATFORM_H + LAYER_GAP * 2 + 40}>
            {/* Vertical connectors between platforms, drawn top-down so they visually link the diamonds. */}
            {[0, 1].map((gapIndex) => {
              const yTop = (LAYER_COUNT - 2 - gapIndex) * LAYER_GAP + PLATFORM_H * 0.32
              const yBottom = yTop + LAYER_GAP
              const segDraw = connectorDraw[gapIndex] ?? 0
              const packetOn = loopEnabled && segDraw > 0.98
              const packetT = packetOn ? loopProgress(holdTime, loopSpeed, 1.6, gapIndex * 0.35) : 0
              return (
                <g key={gapIndex} opacity={segDraw > 0 ? 1 : 0}>
                  <line
                    x1={PLATFORM_W / 2}
                    y1={yTop}
                    x2={PLATFORM_W / 2}
                    y2={yBottom}
                    stroke="rgba(255,255,255,0.22)"
                    strokeWidth={2}
                    strokeDasharray={LAYER_GAP}
                    strokeDashoffset={LAYER_GAP * (1 - segDraw)}
                  />
                  {packetOn && (
                    <circle cx={PLATFORM_W / 2} cy={yTop + (yBottom - yTop) * packetT} r={3.4} fill={accent} opacity={0.9} />
                  )}
                </g>
              )
            })}

            {/* Staircase data-bar path climbing from the bottom to the top platform -- each bar enters in its own staggered turn. */}
            {Array.from({ length: 4 }, (_, i) => {
              const barDraw = stairsDraw[i] ?? 0
              if (barDraw <= 0) return null
              const along = loopEnabled ? loopProgress(holdTime, loopSpeed * 0.8, 2.4, i * 0.25) : i / 4
              const barY = PLATFORM_H + LAYER_GAP * 2 - along * (LAYER_GAP * 2)
              const barX = PLATFORM_W / 2 + 26 + Math.sin(along * Math.PI) * 8
              return <rect key={i} x={barX} y={barY} width={10} height={4} rx={2} fill={accent} opacity={barDraw * 0.85} />
            })}

            {/* Three isometric platform diamonds, bottom (index 0) at the SVG bottom. */}
            {nodes.map((node, i) => {
              const draw = platformDraw[i] ?? 0
              const rise = platformRise[i] ?? 0
              const color = node.color ?? accent
              const y = (LAYER_COUNT - 1 - i) * LAYER_GAP + (1 - rise) * 24
              const breathe = loopEnabled ? pulse(holdTime + i * 0.4, 0.35 * loopSpeed, 0.85, 1) : 1
              return (
                <g key={node.id} transform={`translate(0, ${y})`} opacity={draw > 0 ? Math.min(1, draw) * (0.7 + 0.3 * breathe) : 0}>
                  <path
                    d={DIAMOND}
                    fill={`${color}1f`}
                    stroke={color}
                    strokeWidth={1.6}
                    strokeDasharray={DIAMOND_PERIMETER}
                    strokeDashoffset={DIAMOND_PERIMETER * (1 - draw)}
                    opacity={0.55 + gridDrift}
                  />
                </g>
              )
            })}

            {/* Slowly rotating wheel decorating the bottom (most "active") platform. */}
            {platformDraw[0] > 0.6 && (
              <g transform={`translate(${PLATFORM_W / 2 + 34}, ${(LAYER_COUNT - 1) * LAYER_GAP + PLATFORM_H * 0.32 - 4}) rotate(${wheelAngle})`} opacity={0.8}>
                <circle r={13} fill="none" stroke={accent} strokeWidth={1.6} />
                {[0, 60, 120].map((deg) => (
                  <line key={deg} x1={0} y1={0} x2={13 * Math.cos((deg * Math.PI) / 180)} y2={13 * Math.sin((deg * Math.PI) / 180)} stroke={accent} strokeWidth={1.2} />
                ))}
              </g>
            )}
          </svg>

          {/* HTML node badges (host the icon components) positioned over their SVG platform. */}
          <div className="scene-isometric-nodes">
            {nodes.map((node, i) => {
              const layerP = getStaggeredItemProgress({
                ...staggerSeq,
                phaseStart: nodesPhaseStart,
                itemIndex: i,
                itemCount: nodes.length,
                itemDuration: 0.6 * scale
              })
              const color = node.color ?? accent
              const isWarning = node.status === 'warning' || node.status === 'blocked'
              const warnPulse = isWarning && loopEnabled ? pulse(holdTime, 1.2 * loopSpeed, 0.7, 1) : 1
              const exitLift = exitProgress > 0 ? (1 - exitProgress) : 1
              const bottomOffset = i * LAYER_GAP
              return (
                <div
                  key={node.id}
                  className="scene-isometric-node-wrap"
                  style={{
                    bottom: bottomOffset + PLATFORM_H * 0.32 - 23,
                    opacity: layerP * exitLift,
                    // translateX(-50%) centers the badge over its platform --
                    // folded into this inline transform (not left to the CSS
                    // class) since an inline `transform` fully replaces the
                    // property rather than merging with a class rule.
                    transform: `translateX(-50%) translateY(${(1 - layerP) * 14 - (1 - exitLift) * 10}px) scale(${0.85 + 0.15 * layerP})`
                  }}
                >
                  <span className="scene-isometric-node" style={{ borderColor: color, opacity: isWarning ? warnPulse : 1, boxShadow: isWarning ? `0 0 ${10 * warnPulse}px ${color}` : undefined }}>
                    <SceneIconGlyph icon={{ iconId: node.iconId, color }} defaultColor={color} defaultSize={18} />
                  </span>
                  <span className="scene-isometric-label" lang="km">
                    {node.label}
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
