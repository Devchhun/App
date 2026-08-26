import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, deterministicRotation, getStaggeredItemProgress } from './motion'
import { computeEntrancePhases, getPersonJourneyPose, computeExitPhases } from './animatedVaultDiagram'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { AnimatedVaultDiagramConfig } from '@shared/project'

// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this to fit whatever box the selection handles are dragged to.
// 16:9: text left, diagram right (the tall reference composition). Compact
// (9:16/1:1): text on top, diagram centered below -- narrower/taller for
// 9:16, more centered with less empty space for 1:1.
const INTRINSIC_SIZE = { width: 1400, height: 900 }
const INTRINSIC_SIZE_COMPACT_TALL = { width: 620, height: 1180 } // 9:16
const INTRINSIC_SIZE_COMPACT_SQUARE = { width: 760, height: 980 } // 1:1

// Local SVG coordinate space -- a single 1000x1000 viewBox per spec, tall
// three-floor isometric building centered horizontally, occupying ~82% of
// the viewBox height (90 to 910).
const VIEW_SIZE = 1000
const CX = 500
const HALF_W = 230
const HALF_H = 75
const TOP_Y = 230
const MID_Y = 500
const BOTTOM_Y = 770

function diamondPoints(cy: number): string {
  return `${CX},${cy - HALF_H} ${CX + HALF_W},${cy} ${CX},${cy + HALF_H} ${CX - HALF_W},${cy}`
}

export const ANIMATED_VAULT_DEFAULT_CONFIG: Required<AnimatedVaultDiagramConfig> = {
  outlineColor: '#3CAEEB',
  laserColor: '#FF355F',
  personColor: '#9AA9B4',
  vaultWheelColor: '#3CAEEB',
  surfaceOpacity: 28,
  gridOpacity: 18,
  glowIntensity: 55,
  laserCount: 5,
  showPerson: true,
  showVaultWheel: true,
  showFloorOpening: true
}

function resolveConfig(config: AnimatedVaultDiagramConfig | undefined): Required<AnimatedVaultDiagramConfig> {
  return { ...ANIMATED_VAULT_DEFAULT_CONFIG, ...config }
}

const SECONDARY_OUTLINE = '#205F86'
const STAIR_COLOR = '#266A92'

/** One isometric floor plane: diamond outline (drawn in via stroke-dasharray),
 * dark translucent fill, and a clipped technical grid. */
function FloorPlane({
  cy,
  draw,
  outlineColor,
  surfaceOpacity,
  gridOpacity,
  gridFade,
  clipId
}: {
  cy: number
  draw: number
  outlineColor: string
  surfaceOpacity: number
  gridOpacity: number
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
      <polygon points={diamondPoints(cy)} fill={`rgba(4,18,30,${(surfaceOpacity / 100) * draw})`} stroke="none" />
      <g clipPath={`url(#${clipId})`} opacity={gridFade * draw}>
        {Array.from({ length: 7 }, (_, i) => {
          const t = i / 6
          const x1 = CX - HALF_W + HALF_W * t
          const y1 = cy - HALF_H + HALF_H * t
          const x2 = x1 + HALF_W
          const y2 = y1 - HALF_H
          return <line key={`a${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={outlineColor} strokeWidth={1} opacity={gridOpacity / 100} />
        })}
        {Array.from({ length: 7 }, (_, i) => {
          const t = i / 6
          const x1 = CX - HALF_W + HALF_W * t
          const y1 = cy + HALF_H - HALF_H * t
          const x2 = x1 + HALF_W
          const y2 = y1 + HALF_H
          return <line key={`b${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={outlineColor} strokeWidth={1} opacity={gridOpacity / 100} />
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

/** The stick-figure human, drawn from editable SVG primitives (never an
 * image) with a small deterministic walk/idle-bob cycle. */
function PersonFigure({
  x,
  y,
  facing,
  isWalking,
  isDescending,
  strideT,
  color
}: {
  x: number
  y: number
  facing: -1 | 1
  isWalking: boolean
  isDescending: boolean
  strideT: number
  color: string
}): JSX.Element {
  const swing = isWalking ? Math.sin(strideT * Math.PI * 2) : 0
  const legSwing = swing * 6
  const bob = isWalking ? Math.abs(Math.sin(strideT * Math.PI * 2)) * 2 : Math.sin(strideT * Math.PI * 2) * 0.8
  const tilt = isDescending ? 7 * facing : 0

  return (
    <g data-layer="person" transform={`translate(${x}, ${y - bob}) scale(${facing}, 1) rotate(${tilt})`}>
      <circle cx={0} cy={-30} r={7} fill="#c9d3da" />
      <path d="M -9 -22 Q 0 -30 9 -22 L 8 -2 Q 0 4 -8 -2 Z" fill={color} />
      <line x1={-8} y1={-4} x2={-4 - legSwing} y2={12} stroke={color} strokeWidth={3.4} strokeLinecap="round" opacity={0.85} />
      <line x1={8} y1={-4} x2={4 + legSwing} y2={12} stroke={color} strokeWidth={3.4} strokeLinecap="round" />
    </g>
  )
}

/** Animated Break-In Vault Diagram: a tall, transparent three-floor
 * isometric security-breach diagram (doorway, U-shaped barrier, laser
 * bypass, and a large bank-vault wheel) built entirely from SVG primitives
 * inside one `viewBox="0 0 1000 1000"`. Every position/opacity/rotation is a
 * pure function of the resolved TemplateMotionFrame (enter/hold/exit,
 * localTime -- see motion.ts and animatedVaultDiagram.ts) -- never
 * Date.now()/setInterval/random -- so pausing holds every movement and
 * scrubbing backward reconstructs the exact same frame. Full-frame by
 * default: the BACKGROUND (default: transparent, so the source video stays
 * visible) is painted behind the diagram+text composition but scoped to its
 * own box, so Dim/Gradient/Solid moves and resizes together with the 8
 * on-canvas handles instead of covering the full video frame -- the whole
 * group (background + diagram + text) is one selectable/movable/resizable
 * FOREGROUND unit (scene.contentTransform, via SceneContentFrame). */
export function AnimatedBreakInVaultDiagram({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const isSquare = brand.defaultAspectRatio === '1:1'
  const config = resolveConfig(scene.animatedVaultConfig)
  const eyebrow = scene.content?.eyebrow ?? 'CYBERSECURITY EVENT'
  const title = scene.content?.title ?? scene.visualText

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const glowP = remap(frame.enterProgress, 0, 0.3)

  const entrance = computeEntrancePhases(frame.localTime, options.enterDuration)
  const exit = computeExitPhases(frame.exitProgress)
  const pose = getPersonJourneyPose(entrance.personJourney)
  const strideT = (frame.localTime * 2.4) % 1

  // Hold-phase loops -- all pure functions of holdTime, only active once
  // the entrance has actually finished (entrance.personJourney === 1).
  const holdActive = frame.loopEnabled && entrance.personJourney >= 1
  const outlinePulse = holdActive ? pulse(frame.holdTime, 0.6 * frame.loopSpeed, 0.75, 1) : 1
  const laserPulse = holdActive ? pulse(frame.holdTime, 1.1 * frame.loopSpeed, 0.8, 1) : 1
  const wheelRotation = holdActive ? deterministicRotation(frame.holdTime, 6 * frame.loopSpeed) : 0

  const laserCount = Math.max(1, Math.min(5, Math.round(config.laserCount)))
  const laserStagger = { localTime: frame.localTime, phaseStart: (2.4 * options.enterDuration) / 4, staggerDelay: 0.09, enterDuration: options.enterDuration, intensity: frame.intensity, easing: scene.animationEasing }

  const internalsVisible = 1 - exit.internalsFade
  const outlineVisible = 1 - exit.outlineFade
  const laserVisible = 1 - exit.laserRetract

  const diagram = (
    <svg className="scene-vault2-svg" viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`} width={VIEW_SIZE} height={VIEW_SIZE}>
      <defs>
        <filter id={`${scene.id}-glow`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <radialGradient id={`${scene.id}-glow-grad`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={config.outlineColor} stopOpacity={0.55} />
          <stop offset="55%" stopColor={config.outlineColor} stopOpacity={0.16} />
          <stop offset="100%" stopColor={config.outlineColor} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* 1. Vertical cyan glow -- a brief bright flash on entrance, settling
          into a faint ambient pulse for the hold phase (never a static wash). */}
      <g
        data-layer="glow"
        opacity={entrance.glow * (config.glowIntensity / 100) * outlineVisible * (holdActive ? 0.35 + 0.25 * outlinePulse : 1)}
        style={{ mixBlendMode: 'screen' }}
      >
        <ellipse cx={CX} cy={MID_Y} rx={210} ry={370} fill={`url(#${scene.id}-glow-grad)`} filter={`url(#${scene.id}-glow)`} />
      </g>

      {/* 6. Vertical corner pillars connecting all three floors. */}
      <g data-layer="pillars" opacity={entrance.pillarsConnect * outlineVisible}>
        <line x1={CX - HALF_W} y1={TOP_Y} x2={CX - HALF_W} y2={BOTTOM_Y} stroke={SECONDARY_OUTLINE} strokeWidth={1.2} opacity={0.6 * outlinePulse} />
        <line x1={CX + HALF_W} y1={TOP_Y} x2={CX + HALF_W} y2={BOTTOM_Y} stroke={SECONDARY_OUTLINE} strokeWidth={1.2} opacity={0.6 * outlinePulse} />
      </g>

      {/* 2-4. Three floor planes, bottom drawn first, then middle, then top. */}
      <g opacity={outlineVisible}>
        <FloorPlane
          cy={BOTTOM_Y}
          draw={entrance.bottomFloorDraw}
          outlineColor={config.outlineColor}
          surfaceOpacity={config.surfaceOpacity}
          gridOpacity={config.gridOpacity}
          gridFade={entrance.gridFade}
          clipId={`${scene.id}-clip-bottom`}
        />
        <FloorPlane
          cy={MID_Y}
          draw={entrance.middleFloorDraw}
          outlineColor={config.outlineColor}
          surfaceOpacity={config.surfaceOpacity}
          gridOpacity={config.gridOpacity}
          gridFade={entrance.gridFade}
          clipId={`${scene.id}-clip-middle`}
        />
        <FloorPlane
          cy={TOP_Y}
          draw={entrance.topFloorDraw}
          outlineColor={config.outlineColor}
          surfaceOpacity={config.surfaceOpacity}
          gridOpacity={config.gridOpacity}
          gridFade={entrance.gridFade}
          clipId={`${scene.id}-clip-top`}
        />
      </g>

      {/* Top floor: doorway near the back-left edge. */}
      <g data-layer="doorway" opacity={entrance.topFloorDraw * outlineVisible}>
        <rect x={CX - 145} y={TOP_Y - 78} width={22} height={40} fill="none" stroke={config.outlineColor} strokeWidth={1.4} />
      </g>

      {/* Top floor: U-shaped security barrier near the rear-center/right. */}
      <g data-layer="barrier" opacity={entrance.topFloorDraw * outlineVisible}>
        <path d={`M ${CX + 55} ${TOP_Y - 58} L ${CX + 55} ${TOP_Y - 30} L ${CX + 120} ${TOP_Y - 12}`} fill="none" stroke={SECONDARY_OUTLINE} strokeWidth={2} />
      </g>

      {/* Upper stairs: top floor -> middle floor, right side, one step at a time. */}
      <g data-layer="stairs-upper">
        {Array.from({ length: 5 }, (_, i) => {
          const t = i / 4
          const x = CX + 130 + (CX + 175 - (CX + 130)) * t
          const y = TOP_Y + 55 + (MID_Y - 55 - (TOP_Y + 55)) * t
          const stepDraw = getStaggeredItemProgress({ localTime: frame.localTime, phaseStart: (1.8 * options.enterDuration) / 4, itemIndex: i, itemCount: 5, staggerDelay: 0.05, enterDuration: options.enterDuration, itemDuration: 0.12, intensity: frame.intensity })
          const lit = holdActive ? pulse(frame.holdTime + i * 0.3, 0.8 * frame.loopSpeed, 0.6, 1) : 1
          return <rect key={i} x={x - 11} y={y - 3} width={22} height={6} rx={1.5} fill={STAIR_COLOR} opacity={stepDraw * outlineVisible * lit} />
        })}
      </g>

      {/* Lower stairs: middle floor -> bottom floor, left side. */}
      <g data-layer="stairs-lower">
        {Array.from({ length: 5 }, (_, i) => {
          const t = i / 4
          const x = CX - 150 - (CX - 150 - (CX - 190)) * t
          const y = MID_Y + 40 + (BOTTOM_Y - 40 - (MID_Y + 40)) * t
          const stepDraw = getStaggeredItemProgress({ localTime: frame.localTime, phaseStart: (1.95 * options.enterDuration) / 4, itemIndex: i, itemCount: 5, staggerDelay: 0.05, enterDuration: options.enterDuration, itemDuration: 0.12, intensity: frame.intensity })
          const lit = holdActive ? pulse(frame.holdTime + i * 0.3 + 1, 0.8 * frame.loopSpeed, 0.6, 1) : 1
          return <rect key={i} x={x - 11} y={y - 3} width={22} height={6} rx={1.5} fill={STAIR_COLOR} opacity={stepDraw * outlineVisible * lit} />
        })}
      </g>

      {/* Middle floor: five parallel red laser lines. */}
      <g data-layer="lasers" opacity={laserVisible}>
        {Array.from({ length: laserCount }, (_, i) => {
          const t = 0.2 + i * (0.55 / Math.max(1, laserCount - 1))
          const x1 = CX - HALF_W + HALF_W * t
          const y1 = MID_Y + HALF_H * t
          const x2 = CX + HALF_W * t
          const y2 = MID_Y - HALF_H + HALF_H * t
          const scanIn = getStaggeredItemProgress({ ...laserStagger, itemIndex: i, itemCount: laserCount, itemDuration: 0.16 })
          const pulseA = holdActive ? pulse(frame.holdTime + i * 0.15, 1.4 * frame.loopSpeed, 0.75, 1) : laserPulse
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x1 + (x2 - x1) * scanIn} y2={y1 + (y2 - y1) * scanIn} stroke={config.laserColor} strokeWidth={2.4} opacity={pulseA} />
              <line
                x1={x1}
                y1={y1}
                x2={x1 + (x2 - x1) * scanIn}
                y2={y1 + (y2 - y1) * scanIn}
                stroke={config.laserColor}
                strokeWidth={8}
                opacity={pulseA * 0.18}
              />
            </g>
          )
        })}
      </g>

      {/* Bottom floor: dark oval floor opening, front-left. */}
      {config.showFloorOpening && (
        <g data-layer="floor-opening" opacity={entrance.bottomFloorDraw * outlineVisible}>
          <ellipse cx={CX - 150} cy={BOTTOM_Y + 50} rx={72} ry={26} fill="#140d09" stroke="#5a3a24" strokeWidth={1} opacity={0.9} />
        </g>
      )}

      {/* Bottom floor: large circular bank-vault wheel, right side. */}
      {config.showVaultWheel && (
        <g
          data-layer="vault-wheel"
          transform={`translate(${CX + 150}, ${BOTTOM_Y - 10})`}
          opacity={remap(entrance.vaultWheelReveal, 0, 1) * internalsVisible}
        >
          <g transform={`scale(${0.7 + 0.3 * entrance.vaultWheelReveal})`}>
            <circle r={95} fill="none" stroke={config.vaultWheelColor} strokeWidth={3} opacity={0.9 * outlinePulse} />
            <circle r={80} fill="none" stroke={config.vaultWheelColor} strokeWidth={1.4} opacity={0.6} />
            <g transform={`rotate(${wheelRotation})`}>
              {[0, 72, 144, 216, 288].map((angle) => {
                const rad = (angle * Math.PI) / 180
                return <line key={angle} x1={0} y1={0} x2={78 * Math.cos(rad)} y2={78 * Math.sin(rad)} stroke={config.vaultWheelColor} strokeWidth={2.4} opacity={0.85} />
              })}
            </g>
            <circle r={14} fill={`${config.vaultWheelColor}33`} stroke={config.vaultWheelColor} strokeWidth={2} />
          </g>
        </g>
      )}

      {/* The human figure. */}
      {config.showPerson && entrance.personJourney > 0 && (
        <g opacity={internalsVisible}>
          <PersonFigure x={pose.x} y={pose.y} facing={pose.facing} isWalking={pose.isWalking} isDescending={pose.isDescending} strideT={strideT} color={config.personColor} />
        </g>
      )}
    </svg>
  )

  const composition = (
    <div className={`scene-vault2-root${compact ? ' scene-vault2-root-compact' : ''}${isSquare ? ' scene-vault2-root-square' : ''}`}>
      {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />}
      <div className="scene-vault2-text" style={{ opacity: remap(frame.enterProgress, 0, 0.35) }}>
        {eyebrow && (
          <span className="scene-vault2-eyebrow" style={{ color: accent }}>
            {eyebrow}
          </span>
        )}
        <span className="scene-vault2-title" lang="km">
          {title}
        </span>
      </div>
      <div className="scene-vault2-diagram">{diagram}</div>
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

