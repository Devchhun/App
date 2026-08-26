// Pure, deterministic motion logic for the Animated Break-In Vault Diagram
// template -- every export here is a pure function of the scene's resolved
// TemplateMotionFrame (enterProgress/localTime/exitProgress/holdTime, all
// themselves pure functions of currentTime/startTime/endTime, see motion.ts).
// Never Date.now()/setInterval/random. Kept separate from the .tsx render so
// the 14-step entrance choreography, the hold-phase loops, and the 3-stage
// exit fade are directly unit-testable without rendering, and so seeking the
// Preview timeline always reconstructs the exact same frame.
import { lineDrawProgress } from './motion'

/** The entrance sequence's 14 named beats, each 0-1, ramping across its own
 * window of the scene's `enterDuration` and clamped at its boundary value
 * outside that window (via `lineDrawProgress`, an alias of `remap`) -- so
 * every phase's visuals stay in a valid, deterministic state at any scrub
 * position. Windows are defined against a fixed reference timeline (see
 * REFERENCE_TOTAL) scaled by `enterDuration / REFERENCE_TOTAL`, so a scene
 * using a shorter/longer enter duration still plays the same relative
 * sequence instead of clipping the tail beats or leaving a dead pause. */
export interface EntrancePhases {
  glow: number
  bottomFloorDraw: number
  middleFloorDraw: number
  topFloorDraw: number
  gridFade: number
  pillarsConnect: number
  stairsAppear: number
  vaultWheelReveal: number
  lasersScan: number
  /** Combined 0-1 progress across beats 10-14 (person enters through
   * descends to the vault floor) -- see getPersonJourneyPose for the actual
   * position/pose at any point along it. */
  personJourney: number
}

const REFERENCE_TOTAL = 4.0

function phase(t0: number, t1: number, localTime: number, enterDuration: number): number {
  const scale = enterDuration / REFERENCE_TOTAL
  return lineDrawProgress(localTime, t0 * scale, t1 * scale)
}

export function computeEntrancePhases(localTime: number, enterDuration: number): EntrancePhases {
  const safeEnterDuration = enterDuration > 0 ? enterDuration : 0.01
  return {
    glow: phase(0, 0.3, localTime, safeEnterDuration),
    bottomFloorDraw: phase(0.2, 0.7, localTime, safeEnterDuration),
    middleFloorDraw: phase(0.55, 1.05, localTime, safeEnterDuration),
    topFloorDraw: phase(0.9, 1.4, localTime, safeEnterDuration),
    gridFade: phase(1.3, 1.7, localTime, safeEnterDuration),
    pillarsConnect: phase(1.5, 1.9, localTime, safeEnterDuration),
    stairsAppear: phase(1.8, 2.3, localTime, safeEnterDuration),
    vaultWheelReveal: phase(2.1, 2.5, localTime, safeEnterDuration),
    lasersScan: phase(2.4, 2.9, localTime, safeEnterDuration),
    personJourney: phase(2.7, 4.0, localTime, safeEnterDuration)
  }
}

export interface PersonPose {
  x: number
  y: number
  isWalking: boolean
  isDescending: boolean
  facing: -1 | 1
}

/** Keyframes for beats 10-14, as fractions (0-1) of the combined
 * `personJourney` progress -- local diagram-space units matching the SVG
 * viewBox the template renders (see VIEW_W/VIEW_H/floor Y positions in
 * AnimatedBreakInVaultDiagram.tsx). A keyframe pair with identical x/y is
 * the deliberate pause before the laser barrier. */
const JOURNEY_KEYFRAMES: Array<{ t: number; x: number; y: number; descending: boolean }> = [
  { t: 0.0, x: 420, y: 230, descending: false }, // enters on the top floor
  { t: 0.18, x: 560, y: 300, descending: true }, // walks down the first staircase
  { t: 0.3, x: 430, y: 500, descending: false }, // arrives on the middle floor, approaches the lasers
  { t: 0.42, x: 430, y: 500, descending: false }, // pauses before the laser barrier
  { t: 0.62, x: 620, y: 520, descending: false }, // passes through the laser barrier
  { t: 0.72, x: 460, y: 660, descending: true }, // descends the second staircase
  { t: 1.0, x: 560, y: 760, descending: false } // arrives on the vault floor
]

export function getPersonJourneyPose(personJourney: number): PersonPose {
  const t = Math.max(0, Math.min(1, Number.isFinite(personJourney) ? personJourney : 0))

  let segStart = JOURNEY_KEYFRAMES[0]
  let segEnd = JOURNEY_KEYFRAMES[JOURNEY_KEYFRAMES.length - 1]
  for (let i = 0; i < JOURNEY_KEYFRAMES.length - 1; i++) {
    if (t >= JOURNEY_KEYFRAMES[i].t && t <= JOURNEY_KEYFRAMES[i + 1].t) {
      segStart = JOURNEY_KEYFRAMES[i]
      segEnd = JOURNEY_KEYFRAMES[i + 1]
      break
    }
  }

  const span = segEnd.t - segStart.t
  const local = span > 0 ? (t - segStart.t) / span : 1
  const x = segStart.x + (segEnd.x - segStart.x) * local
  const y = segStart.y + (segEnd.y - segStart.y) * local
  const dx = segEnd.x - segStart.x
  const dy = segEnd.y - segStart.y
  const isWalking = Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6
  const facing: -1 | 1 = dx < 0 ? -1 : dx > 0 ? 1 : lastFacingBefore(segStart.t)

  return { x, y, isWalking, isDescending: segStart.descending || segEnd.descending, facing }
}

function lastFacingBefore(t: number): -1 | 1 {
  for (let i = JOURNEY_KEYFRAMES.length - 2; i >= 0; i--) {
    if (JOURNEY_KEYFRAMES[i].t > t) continue
    const dx = JOURNEY_KEYFRAMES[i + 1].x - JOURNEY_KEYFRAMES[i].x
    if (dx !== 0) return dx < 0 ? -1 : 1
  }
  return 1
}

/** The 3-stage exit fade: person/internal objects fade first, lasers retract
 * next, grid+building outlines fade last. Each is a 0 (fully visible) -> 1
 * (fully faded) ramp across its own window of `exitProgress`. */
export interface ExitPhases {
  internalsFade: number
  laserRetract: number
  outlineFade: number
}

export function computeExitPhases(exitProgress: number): ExitPhases {
  return {
    internalsFade: lineDrawProgress(exitProgress, 0, 0.4),
    laserRetract: lineDrawProgress(exitProgress, 0.25, 0.7),
    outlineFade: lineDrawProgress(exitProgress, 0.55, 1)
  }
}
