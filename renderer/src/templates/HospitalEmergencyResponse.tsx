import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, deterministicRotation } from './motion'
import { computeEntrancePhases, computeExitPhases, getPatientStatusKey, getPatientJourneyPose } from './hospitalResponseMotion'
import type { PatientStatusKey } from './hospitalResponseMotion'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { HospitalEmergencyResponseConfig } from '@shared/project'

const INTRINSIC_SIZE = { width: 1400, height: 900 }
const INTRINSIC_SIZE_COMPACT_TALL = { width: 620, height: 1180 } // 9:16
const INTRINSIC_SIZE_COMPACT_SQUARE = { width: 760, height: 980 } // 1:1

// Local SVG coordinate space -- a single 1000x1000 viewBox, a tall
// three-floor isometric hospital building centered horizontally.
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

export const HOSPITAL_RESPONSE_DEFAULT_CONFIG: Required<HospitalEmergencyResponseConfig> = {
  patientCondition: 'critical',
  emergencySeverity: 70,
  treatmentStageCount: 3,
  showDoctor: true,
  showNurse: true,
  pathColor: '#3CAEEB',
  emergencyColor: '#FF3B4E',
  recoveryColor: '#33D6A6',
  scannerSpeed: 55,
  topFloorLabel: 'Emergency Entrance',
  middleFloorLabel: 'Scanning Room',
  bottomFloorLabel: 'Treatment & Recovery'
}

function resolveConfig(config: HospitalEmergencyResponseConfig | undefined): Required<HospitalEmergencyResponseConfig> {
  return { ...HOSPITAL_RESPONSE_DEFAULT_CONFIG, ...config }
}

const SECONDARY_OUTLINE = '#205F86'

const STATUS_COLOR: Record<PatientStatusKey, (config: Required<HospitalEmergencyResponseConfig>) => string> = {
  critical: (c) => c.emergencyColor,
  treatment: (c) => '#F5A623',
  recovered: (c) => c.recoveryColor
}

function FloorPlane({
  cy,
  draw,
  outlineColor,
  gridFade,
  label,
  clipId
}: {
  cy: number
  draw: number
  outlineColor: string
  gridFade: number
  label?: string
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
      {label && (
        <text x={CX - HALF_W + 8} y={cy - HALF_H - 10} fill={outlineColor} fontSize={13} fontWeight={700} opacity={draw * 0.85}>
          {label}
        </text>
      )}
    </g>
  )
}

function StandingFigure({ x, y, color, bob = 0 }: { x: number; y: number; color: string; bob?: number }): JSX.Element {
  return (
    <g data-layer="figure" transform={`translate(${x}, ${y - bob})`}>
      <circle cx={0} cy={-30} r={7} fill="#c9d3da" />
      <path d="M -9 -22 Q 0 -30 9 -22 L 8 -2 Q 0 4 -8 -2 Z" fill={color} />
      <line x1={-8} y1={-4} x2={-6} y2={12} stroke={color} strokeWidth={3.4} strokeLinecap="round" opacity={0.85} />
      <line x1={8} y1={-4} x2={6} y2={12} stroke={color} strokeWidth={3.4} strokeLinecap="round" />
    </g>
  )
}

/** Hospital Emergency Response: a tall, transparent three-floor isometric
 * hospital diagram (emergency entrance, scanning room, treatment/recovery)
 * built entirely from SVG primitives inside one `viewBox="0 0 1000 1000"`.
 * Every position/opacity/rotation is a pure function of the resolved
 * TemplateMotionFrame (enter/hold/exit, localTime -- see motion.ts and
 * hospitalEmergencyResponse.ts) -- never Date.now()/setInterval/random -- so
 * pausing holds every movement and scrubbing backward reconstructs the exact
 * same frame. Full-frame by default: the BACKGROUND (default: transparent,
 * so the source video stays visible) is painted behind the diagram+text
 * composition but scoped to its own box, so Dim/Gradient/Solid moves and
 * resizes together with the 8 on-canvas handles instead of covering the
 * full video frame. */
export function HospitalEmergencyResponse({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const isSquare = brand.defaultAspectRatio === '1:1'
  const config = resolveConfig(scene.hospitalResponseConfig)
  const eyebrow = scene.content?.eyebrow ?? 'EMERGENCY RESPONSE'
  const title = scene.content?.title ?? scene.visualText

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const glowP = remap(frame.enterProgress, 0, 0.3)

  const entrance = computeEntrancePhases(frame.localTime, options.enterDuration)
  const exit = computeExitPhases(frame.exitProgress)
  const journeyProgress = Math.max(entrance.patientArrives * 0.15, entrance.descendToScan * 0.5, entrance.moveToRecovery * 1)
  const pose = getPatientJourneyPose(journeyProgress)
  const strideT = (frame.localTime * 2.2) % 1

  const holdActive = frame.loopEnabled && entrance.heartbeatGreen >= 1
  const outlinePulse = holdActive ? pulse(frame.holdTime, 0.6 * frame.loopSpeed, 0.75, 1) : 1
  const scannerRotation = holdActive ? deterministicRotation(frame.holdTime, (config.scannerSpeed / 100) * 60 * frame.loopSpeed) : entrance.scannerScans * 140
  const heartbeatT = holdActive ? (frame.holdTime * 0.6 * frame.loopSpeed) % 1 : entrance.heartbeatGreen
  const recoveryBreath = holdActive ? pulse(frame.holdTime, 0.5 * frame.loopSpeed, 0.7, 1) : 1

  const outlineVisible = 1 - exit.outlineFade
  const accentsVisible = 1 - exit.accentsFade
  const effectsVisible = 1 - exit.effectsFade

  const statusKey = getPatientStatusKey(entrance.statusToAmber, entrance.heartbeatGreen)
  const statusColor = STATUS_COLOR[statusKey](config)
  const stageCount = Math.max(2, Math.min(4, Math.round(config.treatmentStageCount)))

  const bob = pose.isWalking ? Math.abs(Math.sin(strideT * Math.PI * 2)) * 2 : holdActive ? 0 : 0

  const diagram = (
    <svg className="scene-her1-svg" viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`} width={VIEW_SIZE} height={VIEW_SIZE}>
      <defs>
        <filter id={`${scene.id}-her-glow`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <radialGradient id={`${scene.id}-her-glow-grad`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={config.pathColor} stopOpacity={0.5} />
          <stop offset="55%" stopColor={config.pathColor} stopOpacity={0.15} />
          <stop offset="100%" stopColor={config.pathColor} stopOpacity={0} />
        </radialGradient>
      </defs>

      <g
        data-layer="glow"
        opacity={entrance.structureDraw * (config.emergencySeverity / 100) * outlineVisible * (holdActive ? 0.35 + 0.25 * outlinePulse : 1)}
        style={{ mixBlendMode: 'screen' }}
      >
        <ellipse cx={CX} cy={MID_Y} rx={210} ry={370} fill={`url(#${scene.id}-her-glow-grad)`} filter={`url(#${scene.id}-her-glow)`} />
      </g>

      <g data-layer="pillars" opacity={entrance.structureDraw * outlineVisible}>
        <line x1={CX - HALF_W} y1={TOP_Y} x2={CX - HALF_W} y2={BOTTOM_Y} stroke={SECONDARY_OUTLINE} strokeWidth={1.2} opacity={0.6} />
        <line x1={CX + HALF_W} y1={TOP_Y} x2={CX + HALF_W} y2={BOTTOM_Y} stroke={SECONDARY_OUTLINE} strokeWidth={1.2} opacity={0.6} />
      </g>

      <g opacity={outlineVisible}>
        <FloorPlane cy={BOTTOM_Y} draw={entrance.structureDraw} outlineColor={config.pathColor} gridFade={entrance.structureDraw} label={config.bottomFloorLabel} clipId={`${scene.id}-clip-bottom`} />
        <FloorPlane cy={MID_Y} draw={entrance.structureDraw} outlineColor={config.pathColor} gridFade={entrance.structureDraw} label={config.middleFloorLabel} clipId={`${scene.id}-clip-middle`} />
        <FloorPlane cy={TOP_Y} draw={entrance.structureDraw} outlineColor={config.pathColor} gridFade={entrance.structureDraw} label={config.topFloorLabel} clipId={`${scene.id}-clip-top`} />
      </g>

      {/* Emergency symbol: a pulsing cross on the top floor. */}
      <g data-layer="emergency-symbol" transform={`translate(${CX + 40}, ${TOP_Y - 40})`} opacity={remap(entrance.emergencyFlash, 0, 1) * accentsVisible}>
        <circle r={20} fill="none" stroke={config.emergencyColor} strokeWidth={2} opacity={0.5 + 0.5 * (holdActive ? pulse(frame.holdTime, 1.2 * frame.loopSpeed, 0.6, 1) : 1)} />
        <line x1={-9} y1={0} x2={9} y2={0} stroke={config.emergencyColor} strokeWidth={4} strokeLinecap="round" />
        <line x1={0} y1={-9} x2={0} y2={9} stroke={config.emergencyColor} strokeWidth={4} strokeLinecap="round" />
      </g>

      {/* Doctor (top floor, receives the patient) and nurse (bottom floor, recovery). */}
      {config.showDoctor && (
        <g opacity={entrance.doctorReceives * outlineVisible}>
          <StandingFigure x={CX + 90} y={TOP_Y + 60} color="#8FA6B8" />
        </g>
      )}
      {config.showNurse && (
        <g opacity={entrance.moveToRecovery * outlineVisible}>
          <StandingFigure x={CX + 110} y={BOTTOM_Y + 50} color="#8FA6B8" />
        </g>
      )}

      {/* Middle floor: the medical scanner. */}
      <g data-layer="scanner" transform={`translate(${CX + 40}, ${MID_Y - 10})`} opacity={remap(entrance.scannerScans, 0, 1) * effectsVisible}>
        <g transform={`scale(${0.7 + 0.3 * entrance.scannerScans})`}>
          <circle r={70} fill="none" stroke={config.pathColor} strokeWidth={2.4} opacity={0.6} />
          <circle r={55} fill="none" stroke={config.pathColor} strokeWidth={1.4} opacity={0.4} />
          <g transform={`rotate(${scannerRotation})`}>
            <line x1={-70} y1={0} x2={70} y2={0} stroke={config.pathColor} strokeWidth={2} opacity={0.8} />
          </g>
        </g>
      </g>

      {/* Diagnosis data travelling from the scanner toward the treatment floor. */}
      {entrance.diagnosisTravels > 0 && entrance.diagnosisTravels < 1 && (
        <circle
          data-layer="diagnosis-packet"
          cx={CX + 40 + (CX + 20 - (CX + 40)) * entrance.diagnosisTravels}
          cy={MID_Y - 10 + (BOTTOM_Y - 40 - (MID_Y - 10)) * entrance.diagnosisTravels}
          r={6}
          fill={config.pathColor}
          opacity={accentsVisible}
          style={{ filter: `drop-shadow(0 0 5px ${config.pathColor})` }}
        />
      )}

      {/* Treatment stages, bottom floor. */}
      <g data-layer="treatment-stages">
        {Array.from({ length: stageCount }, (_, i) => {
          const t = stageCount === 1 ? 0.5 : i / (stageCount - 1)
          const x = CX - 150 + 220 * t
          const y = BOTTOM_Y + 20 - 16 * t
          const active = remap(entrance.treatmentActivate, i / stageCount, (i + 1) / stageCount)
          return (
            <rect
              key={i}
              x={x - 12}
              y={y - 10}
              width={24}
              height={20}
              rx={3}
              fill="none"
              stroke={statusColor}
              strokeWidth={1.6}
              opacity={active * effectsVisible}
            />
          )
        })}
      </g>

      {/* Heartbeat line -- travels continuously during hold, red -> amber -> green. */}
      <g data-layer="heartbeat" transform={`translate(${CX - 180}, ${BOTTOM_Y + 90})`} opacity={entrance.structureDraw * outlineVisible}>
        <path
          d="M 0 0 L 30 0 L 40 -18 L 55 18 L 70 -10 L 85 0 L 120 0"
          fill="none"
          stroke={statusColor}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.85}
          strokeDasharray={140}
          strokeDashoffset={140 * (1 - (holdActive ? 1 : Math.min(1, heartbeatT * 2)))}
        />
        <circle cx={120 * heartbeatT} cy={0} r={holdActive ? 3.5 : 0} fill={statusColor} opacity={holdActive ? recoveryBreath : 0} />
      </g>

      {/* The patient figure, walking the journey between floors. */}
      <g opacity={effectsVisible}>
        <g transform={`translate(${pose.x}, ${pose.y - bob})`}>
          <circle cx={0} cy={-30} r={7} fill="#c9d3da" />
          <path d="M -9 -22 Q 0 -30 9 -22 L 8 -2 Q 0 4 -8 -2 Z" fill={statusColor} />
          <line x1={-8} y1={-4} x2={pose.isWalking ? -4 - Math.sin(strideT * Math.PI * 2) * 6 : -6} y2={12} stroke={statusColor} strokeWidth={3.4} strokeLinecap="round" opacity={0.85} />
          <line x1={8} y1={-4} x2={pose.isWalking ? 4 + Math.sin(strideT * Math.PI * 2) * 6 : 6} y2={12} stroke={statusColor} strokeWidth={3.4} strokeLinecap="round" />
        </g>
      </g>
    </svg>
  )

  const composition = (
    <div className={`scene-her1-root${compact ? ' scene-her1-root-compact' : ''}${isSquare ? ' scene-her1-root-square' : ''}`}>
      {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={glowP} defaultMode="transparent" />}
      <div className="scene-her1-text" style={{ opacity: remap(frame.enterProgress, 0, 0.35) }}>
        {eyebrow && (
          <span className="scene-her1-eyebrow" style={{ color: accent }}>
            {eyebrow}
          </span>
        )}
        <span className="scene-her1-title" lang="km">
          {title}
        </span>
      </div>
      <div className="scene-her1-diagram">{diagram}</div>
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
