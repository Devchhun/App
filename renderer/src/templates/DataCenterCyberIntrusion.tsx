import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, deterministicRotation, getStaggeredItemProgress } from './motion'
import { computeEntrancePhases, computeExitPhases, getRedPacketPosition, getBluePacketPosition } from './dataCenterIntrusionMotion'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { DataCenterCyberIntrusionConfig } from '@shared/project'

// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this to fit whatever box the selection handles are dragged to.
const INTRINSIC_SIZE = { width: 1400, height: 900 }
const INTRINSIC_SIZE_COMPACT_TALL = { width: 620, height: 1180 } // 9:16
const INTRINSIC_SIZE_COMPACT_SQUARE = { width: 760, height: 980 } // 1:1

// Local SVG coordinate space -- a single 1000x1000 viewBox, a tall
// three-floor isometric server building centered horizontally.
const VIEW_SIZE = 1000
const CX = 500
const HALF_W = 240
const HALF_H = 80
const TOP_Y = 220
const MID_Y = 490
const BOTTOM_Y = 760

function diamondPoints(cy: number): string {
  return `${CX},${cy - HALF_H} ${CX + HALF_W},${cy} ${CX},${cy + HALF_H} ${CX - HALF_W},${cy}`
}

export const DATA_CENTER_DEFAULT_CONFIG: Required<DataCenterCyberIntrusionConfig> = {
  serverCount: 4,
  packetCount: 3,
  attackColor: '#FF3B4E',
  secureColor: '#33D6A6',
  firewallColor: '#3CAEEB',
  showAttacker: true,
  showShield: true,
  attackResult: 'blocked',
  glowIntensity: 55
}

function resolveConfig(config: DataCenterCyberIntrusionConfig | undefined): Required<DataCenterCyberIntrusionConfig> {
  return { ...DATA_CENTER_DEFAULT_CONFIG, ...config }
}

const SECONDARY_OUTLINE = '#205F86'

/** One isometric floor plane: diamond outline (drawn in via stroke-dasharray),
 * dark translucent fill, and a clipped technical grid. */
function FloorPlane({
  cy,
  draw,
  outlineColor,
  gridFade,
  clipId
}: {
  cy: number
  draw: number
  outlineColor: string
  gridFade: number
  clipId: string
}): JSX.Element {
  const perimeter = 2 * Math.hypot(HALF_W, HALF_H) * 2
  return (
    <g data-layer={`floor-${cy}`}>
      <defs>
        <clipPath id={clipId}>
          <polygon points={diamondPoints(cy)} />
        </clipPath>
      </defs>
      <polygon points={diamondPoints(cy)} fill={`rgba(4,18,30,${0.28 * draw})`} stroke="none" />
      <g clipPath={`url(#${clipId})`} opacity={gridFade * draw * 0.18}>
        {Array.from({ length: 7 }, (_, i) => {
          const t = i / 6
          const x1 = CX - HALF_W + HALF_W * t
          const y1 = cy - HALF_H + HALF_H * t
          const x2 = x1 + HALF_W
          const y2 = y1 - HALF_H
          return <line key={`a${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={outlineColor} strokeWidth={1} />
        })}
        {Array.from({ length: 7 }, (_, i) => {
          const t = i / 6
          const x1 = CX - HALF_W + HALF_W * t
          const y1 = cy + HALF_H - HALF_H * t
          const x2 = x1 + HALF_W
          const y2 = y1 + HALF_H
          return <line key={`b${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={outlineColor} strokeWidth={1} />
        })}
      </g>
      <polygon
        points={diamondPoints(cy)}
        fill="none"
        stroke={outlineColor}
        strokeWidth={1.6}
        strokeDasharray={perimeter}
        strokeDashoffset={perimeter * (1 - draw)}
      />
    </g>
  )
}

/** A small standing figure -- reused for the attacker (top floor). */
function StandingFigure({ x, y, color, bob }: { x: number; y: number; color: string; bob: number }): JSX.Element {
  return (
    <g data-layer="figure" transform={`translate(${x}, ${y - bob})`}>
      <circle cx={0} cy={-30} r={7} fill="#c9d3da" />
      <path d="M -9 -22 Q 0 -30 9 -22 L 8 -2 Q 0 4 -8 -2 Z" fill={color} />
      <line x1={-8} y1={-4} x2={-6} y2={12} stroke={color} strokeWidth={3.4} strokeLinecap="round" opacity={0.85} />
      <line x1={8} y1={-4} x2={6} y2={12} stroke={color} strokeWidth={3.4} strokeLinecap="round" />
    </g>
  )
}

/** Data Center Cyber Intrusion: a tall, transparent three-floor isometric
 * server-room diagram (server racks, a dividing firewall wall, and a
 * shielded database core) built entirely from SVG primitives inside one
 * `viewBox="0 0 1000 1000"`. Every position/opacity/rotation is a pure
 * function of the resolved TemplateMotionFrame (enter/hold/exit, localTime
 * -- see motion.ts and dataCenterCyberIntrusion.ts) -- never
 * Date.now()/setInterval/random -- so pausing holds every movement and
 * scrubbing backward reconstructs the exact same frame. Full-frame by
 * default: the BACKGROUND (default: transparent, so the source video stays
 * visible) is painted behind the diagram+text composition but scoped to its
 * own box, so Dim/Gradient/Solid moves and resizes together with the 8
 * on-canvas handles instead of covering the full video frame. */
export function DataCenterCyberIntrusion({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const isSquare = brand.defaultAspectRatio === '1:1'
  const config = resolveConfig(scene.dataCenterConfig)
  const eyebrow = scene.content?.eyebrow ?? 'CYBERSECURITY EVENT'
  const title = scene.content?.title ?? scene.visualText
  const breached = config.attackResult === 'breached'

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const glowP = remap(frame.enterProgress, 0, 0.3)

  const entrance = computeEntrancePhases(frame.localTime, options.enterDuration)
  const exit = computeExitPhases(frame.exitProgress)

  const holdActive = frame.loopEnabled && entrance.systemsGreen >= 1
  const outlinePulse = holdActive ? pulse(frame.holdTime, 0.6 * frame.loopSpeed, 0.75, 1) : 1
  const shieldPulse = holdActive ? pulse(frame.holdTime, 0.9 * frame.loopSpeed, 0.7, 1) : 1
  const firewallSweep = holdActive ? deterministicRotation(frame.holdTime, 40 * frame.loopSpeed) / 360 : 0
  const ledBlink = holdActive ? pulse(frame.holdTime + 0.5, 1.6 * frame.loopSpeed, 0.4, 1) : 1

  const outlineVisible = 1 - exit.outlineFade
  const accentsVisible = 1 - exit.accentsFade
  const effectsVisible = 1 - exit.effectsFade

  const serverCount = Math.max(1, Math.min(8, Math.round(config.serverCount)))
  const packetCount = Math.max(1, Math.min(6, Math.round(config.packetCount)))

  const finalColor = breached ? config.attackColor : config.secureColor
  const finalGlow = holdActive ? outlinePulse : entrance.systemsGreen

  const attackerBob = holdActive ? Math.sin(frame.holdTime * 1.4) * 2 : 0

  const diagram = (
    <svg className="scene-dc1-svg" viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`} width={VIEW_SIZE} height={VIEW_SIZE}>
      <defs>
        <filter id={`${scene.id}-dc-glow`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <radialGradient id={`${scene.id}-dc-glow-grad`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={config.firewallColor} stopOpacity={0.5} />
          <stop offset="55%" stopColor={config.firewallColor} stopOpacity={0.15} />
          <stop offset="100%" stopColor={config.firewallColor} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* Ambient structural glow -- brief flash on entrance, faint pulse on hold. */}
      <g
        data-layer="glow"
        opacity={entrance.floorsDraw * (config.glowIntensity / 100) * outlineVisible * (holdActive ? 0.35 + 0.25 * outlinePulse : 1)}
        style={{ mixBlendMode: 'screen' }}
      >
        <ellipse cx={CX} cy={MID_Y} rx={210} ry={370} fill={`url(#${scene.id}-dc-glow-grad)`} filter={`url(#${scene.id}-dc-glow)`} />
      </g>

      {/* Vertical corner pillars connecting all three floors. */}
      <g data-layer="pillars" opacity={entrance.floorsDraw * outlineVisible}>
        <line x1={CX - HALF_W} y1={TOP_Y} x2={CX - HALF_W} y2={BOTTOM_Y} stroke={SECONDARY_OUTLINE} strokeWidth={1.2} opacity={0.6} />
        <line x1={CX + HALF_W} y1={TOP_Y} x2={CX + HALF_W} y2={BOTTOM_Y} stroke={SECONDARY_OUTLINE} strokeWidth={1.2} opacity={0.6} />
      </g>

      {/* Three floor planes, bottom drawn first, then middle, then top. */}
      <g opacity={outlineVisible}>
        <FloorPlane cy={BOTTOM_Y} draw={entrance.floorsDraw} outlineColor={config.firewallColor} gridFade={entrance.floorsDraw} clipId={`${scene.id}-clip-bottom`} />
        <FloorPlane cy={MID_Y} draw={entrance.floorsDraw} outlineColor={config.firewallColor} gridFade={entrance.floorsDraw} clipId={`${scene.id}-clip-middle`} />
        <FloorPlane cy={TOP_Y} draw={entrance.floorsDraw} outlineColor={config.firewallColor} gridFade={entrance.floorsDraw} clipId={`${scene.id}-clip-top`} />
      </g>

      {/* Top floor: server racks, illuminating one after another. */}
      <g data-layer="servers">
        {Array.from({ length: serverCount }, (_, i) => {
          const t = serverCount === 1 ? 0.5 : i / (serverCount - 1)
          const rx = CX - 150 + 300 * t
          const ry = TOP_Y - 30 - 20 * t
          const lightUp = getStaggeredItemProgress({
            localTime: frame.localTime,
            phaseStart: (0.9 * options.enterDuration) / 5.7,
            itemIndex: i,
            itemCount: serverCount,
            staggerDelay: 0.06,
            enterDuration: options.enterDuration,
            itemDuration: 0.14,
            intensity: frame.intensity,
            easing: scene.animationEasing
          })
          const lit = holdActive ? ledBlink : 1
          return (
            <g key={i} transform={`translate(${rx}, ${ry})`} opacity={lightUp * outlineVisible}>
              <rect x={-14} y={-30} width={28} height={60} rx={2} fill="rgba(4,18,30,0.6)" stroke={config.firewallColor} strokeWidth={1.2} />
              {[-18, -6, 6, 18].map((dy) => (
                <rect key={dy} x={-9} y={dy - 2} width={18} height={3} fill={config.firewallColor} opacity={0.5 + 0.5 * lit} />
              ))}
            </g>
          )
        })}
      </g>

      {/* Top floor: attacker figure at the left edge. */}
      {config.showAttacker && (
        <g opacity={entrance.serversIlluminate * outlineVisible * accentsVisible}>
          <StandingFigure x={CX - 180} y={TOP_Y + 60} color={config.attackColor} bob={attackerBob} />
        </g>
      )}

      {/* Middle floor: the firewall wall dividing the building. */}
      <g data-layer="firewall" opacity={entrance.floorsDraw * outlineVisible}>
        <rect
          x={CX - 6}
          y={MID_Y - HALF_H - 40}
          width={12}
          height={HALF_H * 2 + 40}
          fill={config.firewallColor}
          opacity={0.22 + 0.5 * entrance.firewallImpactFlash * (1 - entrance.firewallRestore)}
        />
        {Array.from({ length: 6 }, (_, row) => (
          <line
            key={row}
            x1={CX - 6}
            y1={MID_Y - HALF_H - 30 + row * 16}
            x2={CX + 6}
            y2={MID_Y - HALF_H - 30 + row * 16}
            stroke={SECONDARY_OUTLINE}
            strokeWidth={1}
            opacity={0.5}
          />
        ))}
        {/* Impact flash pulses at the point of attack. */}
        <circle
          cx={CX}
          cy={MID_Y}
          r={18 + 40 * entrance.firewallImpactFlash}
          fill="none"
          stroke={config.attackColor}
          strokeWidth={2.2}
          opacity={(1 - entrance.firewallImpactFlash) * (entrance.firewallImpactFlash > 0 ? 1 : 0) * accentsVisible}
        />
        {/* Hold-phase scanning sweep. */}
        <rect
          x={CX - 6}
          y={MID_Y - HALF_H - 40 + (HALF_H * 2 + 40) * firewallSweep - 4}
          width={12}
          height={8}
          fill={config.firewallColor}
          opacity={holdActive ? 0.55 : 0}
        />
      </g>

      {/* Bottom floor: shielded database core. */}
      {config.showShield && (
        <g data-layer="shield" transform={`translate(${CX}, ${BOTTOM_Y - 20})`} opacity={remap(entrance.shieldActivate, 0, 1) * effectsVisible}>
          <g transform={`scale(${0.7 + 0.3 * entrance.shieldActivate})`}>
            <path
              d="M 0 -55 L 42 -35 L 42 10 Q 42 45 0 60 Q -42 45 -42 10 L -42 -35 Z"
              fill={`${finalColor}22`}
              stroke={finalColor}
              strokeWidth={2.4}
              opacity={0.5 + 0.5 * (holdActive ? shieldPulse : finalGlow)}
            />
            <path d="M -16 -2 L -4 12 L 20 -18" fill="none" stroke={finalColor} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" opacity={entrance.systemsGreen} />
          </g>
        </g>
      )}

      {/* Detection ring tracking the malicious packet. */}
      {entrance.detectionRingTrack > 0 && entrance.detectionRingTrack < 1 && (
        (() => {
          const pos = getRedPacketPosition(0.75 + 0.15 * entrance.detectionRingTrack, breached)
          return (
            <circle
              data-layer="detection-ring"
              cx={pos.x}
              cy={pos.y}
              r={22}
              fill="none"
              stroke={config.secureColor}
              strokeWidth={2}
              strokeDasharray="6 4"
              opacity={entrance.securityScanActivate * (1 - entrance.detectionRingTrack) * accentsVisible}
            />
          )
        })()
      )}

      {/* Malicious (red) packets entering from the left, staggered. */}
      <g data-layer="red-packets">
        {Array.from({ length: packetCount }, (_, i) => {
          const packetProgress = getStaggeredItemProgress({
            localTime: frame.localTime,
            phaseStart: (1.5 * options.enterDuration) / 5.7,
            itemIndex: i,
            itemCount: packetCount,
            staggerDelay: 0.08,
            enterDuration: options.enterDuration,
            itemDuration: (3.3 * options.enterDuration) / 5.7,
            intensity: frame.intensity,
            easing: 'linear'
          })
          if (packetProgress <= 0) return null
          const blockedFadeStart = 0.85
          const fade = !breached && packetProgress > blockedFadeStart ? Math.max(0, 1 - (packetProgress - blockedFadeStart) / (1 - blockedFadeStart)) : 1
          const pos = getRedPacketPosition(packetProgress, breached)
          return (
            <circle
              key={i}
              cx={pos.x}
              cy={pos.y}
              r={7}
              fill={config.attackColor}
              opacity={fade * effectsVisible}
              style={{ filter: `drop-shadow(0 0 6px ${config.attackColor})` }}
            />
          )
        })}
      </g>

      {/* Legitimate (blue) packets on the safe route -- loop continuously
          once the entrance settles. */}
      <g data-layer="blue-packets" opacity={entrance.systemsGreen * outlineVisible}>
        {[0, 0.5].map((offset, i) => {
          const t = holdActive ? (frame.holdTime * 0.35 * frame.loopSpeed + offset) % 1 : Math.min(1, entrance.systemsGreen)
          const pos = getBluePacketPosition(t)
          return <circle key={i} cx={pos.x} cy={pos.y} r={6} fill={config.secureColor} opacity={0.9} style={{ filter: `drop-shadow(0 0 5px ${config.secureColor})` }} />
        })}
      </g>
    </svg>
  )

  const composition = (
    <div className={`scene-dc1-root${compact ? ' scene-dc1-root-compact' : ''}${isSquare ? ' scene-dc1-root-square' : ''}`}>
      {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />}
      <div className="scene-dc1-text" style={{ opacity: remap(frame.enterProgress, 0, 0.35) }}>
        {eyebrow && (
          <span className="scene-dc1-eyebrow" style={{ color: accent }}>
            {eyebrow}
          </span>
        )}
        <span className="scene-dc1-title" lang="km">
          {title}
        </span>
      </div>
      <div className="scene-dc1-diagram">{diagram}</div>
    </div>
  )

  const intrinsic = !compact ? INTRINSIC_SIZE : isSquare ? INTRINSIC_SIZE_COMPACT_SQUARE : INTRINSIC_SIZE_COMPACT_TALL

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
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
