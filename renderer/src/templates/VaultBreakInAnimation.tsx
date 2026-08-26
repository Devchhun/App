import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, pulse, getStaggeredItemProgress, lineDrawProgress } from './motion'
import { computeVaultStoryPhases, getPersonPose, computeLaserActivity, computeVaultWheelState, type BypassStyle } from './vaultBreakIn'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { VaultBreakInConfig } from '@shared/project'

// The composition's natural (unscaled) design-space size -- SceneContentFrame
// scales this to fit whatever box the selection handles are dragged to.
// 16:9: text left, diagram right (diagram ~62% of the width). Compact
// (9:16/1:1): text on top, diagram stacked below -- a genuinely different
// arrangement, not the row layout merely shrunk.
const INTRINSIC_SIZE = { width: 1480, height: 640 }
const INTRINSIC_SIZE_COMPACT = { width: 720, height: 1200 }

// Local SVG coordinate space the diagram itself is authored in (matches the
// waypoints in vaultBreakIn.ts's PERSON_KEYFRAMES).
const VIEW_W = 360
const VIEW_H = 640
const FLOOR_W = 300
const FLOOR_H = 130
const TOP_FLOOR_Y = 90
const MID_FLOOR_Y = 320
const BOTTOM_FLOOR_Y = 550
const CX = 180

function diamondPath(cx: number, cy: number, w: number, h: number): string {
  return `M ${cx} ${cy - h / 2} L ${cx + w / 2} ${cy} L ${cx} ${cy + h / 2} L ${cx - w / 2} ${cy} Z`
}
const DIAMOND_PERIMETER = 2 * Math.hypot(FLOOR_W / 2, FLOOR_H / 2) * 2

export const VAULT_DEFAULT_CONFIG: Required<VaultBreakInConfig> = {
  structureColor: '#4fd8ff',
  gridOpacity: 35,
  personColor: '#ffe4a3',
  laserCount: 5,
  laserColor: '#ff3b4e',
  laserGlow: 65,
  bypassStyle: 'sequential',
  laserReactivation: true,
  vaultMetalColor: '#9fb2c4',
  vaultLockedColor: '#34d3ff',
  vaultUnlockedColor: '#2ee88a',
  vaultSpokeCount: 6,
  wheelRotationDegrees: 150,
  showFloorHatch: true
}

function resolveConfig(config: VaultBreakInConfig | undefined): Required<VaultBreakInConfig> {
  return { ...VAULT_DEFAULT_CONFIG, ...config }
}

/** The stick-figure human, drawn from editable SVG primitives (never an
 * image) with a small deterministic walk cycle -- `strideT` (0-1, wraps) is
 * a pure function of `storyProgress`, never wall-clock time, so the pose at
 * any scrub position is exactly reproducible. */
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
  const legSwing = swing * 7
  const armSwing = swing * 6
  const bob = isWalking ? Math.abs(Math.sin(strideT * Math.PI * 2)) * 1.6 : 0
  const tilt = isDescending ? 8 * facing : 0

  return (
    <g transform={`translate(${x}, ${y - bob}) scale(${facing}, 1) rotate(${tilt})`}>
      {/* head */}
      <circle cx={0} cy={-24} r={4.5} fill={color} />
      {/* body */}
      <line x1={0} y1={-19.5} x2={0} y2={-6} stroke={color} strokeWidth={2.4} strokeLinecap="round" />
      {/* back arm */}
      <line x1={0} y1={-17} x2={-5 + armSwing} y2={-6} stroke={color} strokeWidth={2} strokeLinecap="round" opacity={0.85} />
      {/* front arm */}
      <line x1={0} y1={-17} x2={5 - armSwing} y2={-6} stroke={color} strokeWidth={2} strokeLinecap="round" />
      {/* back leg */}
      <line x1={0} y1={-6} x2={-4 - legSwing} y2={6} stroke={color} strokeWidth={2.2} strokeLinecap="round" opacity={0.85} />
      {/* front leg */}
      <line x1={0} y1={-6} x2={4 + legSwing} y2={6} stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </g>
  )
}

/** Vault Break-In Animation: a three-floor isometric heist scene where an
 * SVG human figure walks down through the floors, bypasses a configurable
 * red laser barrier, and unlocks a rotating steel bank-vault wheel. Every
 * position/rotation/color-mix is a pure function of `storyProgress`
 * (localTime/duration across the whole scene) via vaultBreakIn.ts -- never
 * wall-clock time, so pausing holds every movement and scrubbing backward
 * reconstructs the exact same frame. Full-frame by default: the BACKGROUND
 * (default: transparent, so the source video stays visible) spans the full
 * design canvas, while the whole diagram+text composition is a separate,
 * independently selectable/movable/resizable FOREGROUND group
 * (scene.contentTransform, via SceneContentFrame). */
export function VaultBreakInAnimation({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const config = resolveConfig(scene.vaultConfig)
  const eyebrow = scene.content?.eyebrow ?? 'CYBERSECURITY EVENT'
  const title = scene.content?.title ?? scene.visualText

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const glowP = remap(frame.enterProgress, 0, 0.3)

  // The whole heist story unfolds across the SCENE's own full duration (not
  // just the enter window) -- a one-time narrative, not a perpetually
  // looping hold state. Still purely derived from localTime/duration, so it
  // is exactly as deterministic/scrub-safe as every other motion in this app.
  const storyProgress = frame.duration > 0 ? Math.max(0, Math.min(1, frame.localTime / frame.duration)) : 0
  const phases = computeVaultStoryPhases(storyProgress)
  const pose = getPersonPose(storyProgress)
  const laserActivity = computeLaserActivity(config.laserCount, config.bypassStyle as BypassStyle, phases.laserBypass, phases.crossAndDescend, config.laserReactivation)
  const vaultState = computeVaultWheelState(phases.vaultUnlock, config.wheelRotationDegrees)

  // A small stride frequency driven by localTime (never Date.now()) -- only
  // matters while walking, so its exact phase elsewhere is invisible.
  const strideT = (frame.localTime * 2.2) % 1

  // Flicker (cosmetic only): a restrained left-to-right shimmer on the
  // lasers just before/while the bypass sequence runs -- built from the
  // SAME deterministic localTime-driven pulse() used everywhere else in the
  // app, gated to the approach + early-bypass window so it never runs as an
  // unbounded background loop.
  const flickerWindow = Math.max(0, phases.approachLasers - phases.laserBypass * 0.6)

  const floorStaggerSeq = { localTime: frame.localTime, phaseStart: 0, staggerDelay: options.staggerDelay, enterDuration: options.enterDuration * 0.5, intensity: frame.intensity, easing: scene.animationEasing }
  const floorDraw = [0, 1, 2].map((i) => getStaggeredItemProgress({ ...floorStaggerSeq, itemIndex: i, itemCount: 3, itemDuration: options.enterDuration * 0.22 }))

  const laserSpanLeft = CX - 110
  const laserSpanRight = CX + 60
  const laserY = MID_FLOOR_Y - 6

  const diagram = (
    <svg className="scene-vault-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width={VIEW_W} height={VIEW_H}>
      {/* Vertical connectors between floors. */}
      <line x1={CX + 60} y1={TOP_FLOOR_Y + 45} x2={CX + 90} y2={MID_FLOOR_Y - 45} stroke={config.structureColor} strokeWidth={1.4} opacity={0.25 * phases.floorsDraw} />
      <line x1={CX - 60} y1={MID_FLOOR_Y + 45} x2={CX - 30} y2={BOTTOM_FLOOR_Y - 45} stroke={config.structureColor} strokeWidth={1.4} opacity={0.25 * phases.floorsDraw} />

      {/* Upper stairs (top floor -> middle floor). */}
      {Array.from({ length: 5 }, (_, i) => {
        const t = i / 4
        const stepX = 250 + (270 - 250) * t
        const stepY = 140 + (290 - 140) * t
        return <rect key={i} x={stepX - 9} y={stepY - 2.5} width={18} height={5} rx={1} fill={config.structureColor} opacity={0.55 * lineDrawProgress(phases.walkUpper, 0, 0.7)} />
      })}

      {/* Lower stairs (middle floor -> bottom floor). */}
      {Array.from({ length: 5 }, (_, i) => {
        const t = i / 4
        const stepX = 130 + (150 - 130) * t
        const stepY = 345 + (490 - 345) * t
        return <rect key={i} x={stepX - 9} y={stepY - 2.5} width={18} height={5} rx={1} fill={config.structureColor} opacity={0.55 * lineDrawProgress(phases.crossAndDescend, 0.1, 0.55)} />
      })}

      {/* Three isometric floor platforms with a perspective grid. */}
      {[
        { cy: TOP_FLOOR_Y, draw: floorDraw[2] },
        { cy: MID_FLOOR_Y, draw: floorDraw[1] },
        { cy: BOTTOM_FLOOR_Y, draw: floorDraw[0] }
      ].map((floor, i) => (
        <g key={i}>
          <path
            d={diamondPath(CX, floor.cy, FLOOR_W, FLOOR_H)}
            fill={`${config.structureColor}14`}
            stroke={config.structureColor}
            strokeWidth={1.8}
            strokeDasharray={DIAMOND_PERIMETER}
            strokeDashoffset={DIAMOND_PERIMETER * (1 - floor.draw)}
          />
          {floor.draw > 0.3 && (
            <>
              <line
                x1={CX - FLOOR_W / 4}
                y1={floor.cy - FLOOR_H / 4}
                x2={CX + FLOOR_W / 4}
                y2={floor.cy + FLOOR_H / 4}
                stroke={config.structureColor}
                strokeWidth={1}
                opacity={(config.gridOpacity / 100) * floor.draw}
              />
              <line
                x1={CX + FLOOR_W / 4}
                y1={floor.cy - FLOOR_H / 4}
                x2={CX - FLOOR_W / 4}
                y2={floor.cy + FLOOR_H / 4}
                stroke={config.structureColor}
                strokeWidth={1}
                opacity={(config.gridOpacity / 100) * floor.draw}
              />
            </>
          )}
        </g>
      ))}

      {/* Floor hatch near the vault. */}
      {config.showFloorHatch && (
        <ellipse
          cx={250}
          cy={BOTTOM_FLOOR_Y + 24}
          rx={26}
          ry={11}
          fill="#05070a"
          stroke={vaultState.unlockMix > 0.5 ? config.vaultUnlockedColor : config.vaultLockedColor}
          strokeWidth={1.2}
          opacity={0.5 + 0.4 * vaultState.unlockMix}
        />
      )}

      {/* Red laser barrier on the middle floor. */}
      {laserActivity.map((active, i) => {
        const ly = laserY - 16 + i * 8
        const flicker = flickerWindow > 0 ? pulse(frame.localTime + i * 0.18, 6, 0.75, 1) : 1
        const opacity = active * flicker
        return (
          <g key={i}>
            <line x1={laserSpanLeft} y1={ly} x2={laserSpanRight} y2={ly} stroke={config.laserColor} strokeWidth={2.2} opacity={opacity} />
            <line
              x1={laserSpanLeft}
              y1={ly}
              x2={laserSpanRight}
              y2={ly}
              stroke={config.laserColor}
              strokeWidth={2.2 + (config.laserGlow / 100) * 7}
              opacity={opacity * 0.28}
            />
            {/* Subtle red reflection on the platform beneath each active laser. */}
            <line x1={laserSpanLeft} y1={ly + 22} x2={laserSpanRight} y2={ly + 22} stroke={config.laserColor} strokeWidth={1} opacity={opacity * 0.12} />
          </g>
        )
      })}

      {/* Bank-vault wheel on the bottom floor. */}
      <g transform={`translate(${250}, ${BOTTOM_FLOOR_Y - 6})`}>
        <circle r={34} fill="none" stroke={config.vaultMetalColor} strokeWidth={7} opacity={phases.crossAndDescend} />
        <circle r={24} fill={`${config.vaultMetalColor}22`} stroke={config.vaultMetalColor} strokeWidth={1.5} opacity={phases.crossAndDescend} />
        <g transform={`rotate(${vaultState.rotationDegrees})`} opacity={phases.crossAndDescend}>
          {(() => {
            const spokeCount = Math.max(4, Math.min(10, Math.round(config.vaultSpokeCount)))
            return Array.from({ length: spokeCount }, (_, i) => {
              const angle = (360 / spokeCount) * i
              const rad = (angle * Math.PI) / 180
              return <line key={i} x1={0} y1={0} x2={22 * Math.cos(rad)} y2={22 * Math.sin(rad)} stroke={config.vaultMetalColor} strokeWidth={2} />
            })
          })()}
          {/* Locking bolts, retracting outward as the vault unlocks. */}
          {[0, 90, 180, 270].map((angle) => {
            const rad = (angle * Math.PI) / 180
            const dist = 30 + vaultState.boltRetract * 8
            return (
              <rect
                key={angle}
                x={dist * Math.cos(rad) - 3}
                y={dist * Math.sin(rad) - 3}
                width={6}
                height={6}
                fill={config.vaultMetalColor}
                opacity={1 - vaultState.boltRetract * 0.6}
              />
            )
          })}
        </g>
        {/* Central hub, pulsing while the wheel is actively turning. */}
        <circle
          r={7}
          fill={vaultState.unlockMix > 0 ? config.vaultUnlockedColor : config.vaultLockedColor}
          opacity={phases.crossAndDescend * (phases.vaultUnlock > 0 && phases.vaultUnlock < 1 ? pulse(frame.localTime, 5, 0.75, 1) : 1)}
        />
        {/* Locked (cyan/red) <-> unlocked (green) glow crossfade. */}
        <circle r={40} fill="none" stroke={config.vaultLockedColor} strokeWidth={2} opacity={(1 - vaultState.unlockMix) * 0.55 * phases.crossAndDescend} />
        <circle r={40} fill="none" stroke={config.vaultUnlockedColor} strokeWidth={2} opacity={vaultState.unlockMix * 0.75 * phases.crossAndDescend} />
      </g>

      {/* The human figure. */}
      {phases.floorsDraw > 0.5 && (
        <PersonFigure x={pose.x} y={pose.y} facing={pose.facing} isWalking={pose.isWalking} isDescending={pose.isDescending} strideT={strideT} color={config.personColor} />
      )}

      {/* Success glow once the vault is fully unlocked. */}
      {phases.successGlow > 0 && (
        <circle cx={250} cy={BOTTOM_FLOOR_Y - 6} r={70} fill={`${config.vaultUnlockedColor}22`} opacity={phases.successGlow} />
      )}
    </svg>
  )

  const composition = (
    <div className={`scene-vault-root${compact ? ' scene-vault-root-compact' : ''}`}>
      <div className="scene-vault-text" style={{ opacity: remap(frame.enterProgress, 0, 0.4) }}>
        {eyebrow && (
          <span className="scene-vault-eyebrow" style={{ color: accent }}>
            {eyebrow}
          </span>
        )}
        <span className="scene-vault-title" lang="km" style={{ textShadow: phases.successGlow > 0.3 ? `0 0 ${18 * phases.successGlow}px ${config.vaultUnlockedColor}` : undefined }}>
          {title}
        </span>
      </div>
      <div className="scene-vault-diagram">{diagram}</div>
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
