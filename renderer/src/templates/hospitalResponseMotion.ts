// Pure, deterministic motion logic for the Hospital Emergency Response
// template -- every export here is a pure function of the scene's resolved
// TemplateMotionFrame (see motion.ts). Never Date.now()/setInterval/random.
// Kept separate from the .tsx render so the 12-step entrance choreography,
// the hold-phase loops, and the patient-path interpolation are directly
// unit-testable without rendering, and so seeking the Preview timeline
// always reconstructs the exact same frame.
import { lineDrawProgress } from './motion'

/** The entrance sequence's 12 named beats, each 0-1, ramping across its own
 * window of a fixed reference timeline (see REFERENCE_TOTAL) scaled by
 * `enterDuration / REFERENCE_TOTAL`, so a scene using a shorter/longer enter
 * duration still plays the same relative sequence instead of clipping the
 * tail beats or leaving a dead pause. */
export interface EntrancePhases {
  structureDraw: number
  emergencyFlash: number
  patientArrives: number
  doctorReceives: number
  vitalPulseRed: number
  descendToScan: number
  scannerScans: number
  diagnosisTravels: number
  treatmentActivate: number
  statusToAmber: number
  moveToRecovery: number
  heartbeatGreen: number
}

const REFERENCE_TOTAL = 5.5

function phase(t0: number, t1: number, localTime: number, enterDuration: number): number {
  const scale = enterDuration / REFERENCE_TOTAL
  return lineDrawProgress(localTime, t0 * scale, t1 * scale)
}

export function computeEntrancePhases(localTime: number, enterDuration: number): EntrancePhases {
  const safeEnter = Number.isFinite(enterDuration) && enterDuration > 0 ? enterDuration : 0.01
  const t = Number.isFinite(localTime) ? localTime : 0
  return {
    structureDraw: phase(0.0, 1.1, t, safeEnter),
    emergencyFlash: phase(0.9, 1.3, t, safeEnter),
    patientArrives: phase(1.2, 1.7, t, safeEnter),
    doctorReceives: phase(1.6, 2.0, t, safeEnter),
    vitalPulseRed: phase(1.9, 2.3, t, safeEnter),
    descendToScan: phase(2.2, 2.8, t, safeEnter),
    scannerScans: phase(2.7, 3.3, t, safeEnter),
    diagnosisTravels: phase(3.2, 3.7, t, safeEnter),
    treatmentActivate: phase(3.6, 4.0, t, safeEnter),
    statusToAmber: phase(3.9, 4.3, t, safeEnter),
    moveToRecovery: phase(4.2, 4.8, t, safeEnter),
    heartbeatGreen: phase(4.7, 5.3, t, safeEnter)
  }
}

export { REFERENCE_TOTAL as ENTRANCE_REFERENCE_TOTAL }

export interface ExitPhases {
  effectsFade: number
  accentsFade: number
  outlineFade: number
}

export function computeExitPhases(exitProgress: number): ExitPhases {
  const p = Number.isFinite(exitProgress) ? Math.max(0, Math.min(1, exitProgress)) : 0
  return {
    effectsFade: lineDrawProgress(p, 0, 0.4),
    accentsFade: lineDrawProgress(p, 0.3, 0.7),
    outlineFade: lineDrawProgress(p, 0.6, 1)
  }
}

/** Patient status color key, derived from the combined entrance progress --
 * red while critical/arriving, amber during treatment, green once recovered.
 * A pure function so any renderer/test can ask "what color right now" without
 * re-deriving the phase math. */
export type PatientStatusKey = 'critical' | 'treatment' | 'recovered'

export function getPatientStatusKey(statusToAmber: number, heartbeatGreen: number): PatientStatusKey {
  if (heartbeatGreen >= 1) return 'recovered'
  if (statusToAmber > 0) return 'treatment'
  return 'critical'
}

export interface PathPoint {
  x: number
  y: number
}

const clampProgress = (t: number): number => (Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0)

function interpolatePath(keyframes: Array<{ t: number } & PathPoint>, progress: number): PathPoint {
  const p = clampProgress(progress)
  if (keyframes.length === 0) return { x: 0, y: 0 }
  if (p <= keyframes[0].t) return { x: keyframes[0].x, y: keyframes[0].y }
  const last = keyframes[keyframes.length - 1]
  if (p >= last.t) return { x: last.x, y: last.y }
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]
    const b = keyframes[i + 1]
    if (p >= a.t && p <= b.t) {
      const span = b.t - a.t
      const localT = span <= 0 ? 0 : (p - a.t) / span
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT }
    }
  }
  return { x: last.x, y: last.y }
}

/** The patient's journey across the three floors: arrival on the top
 * (emergency) floor, down to the middle (scanning) floor, then down to the
 * bottom (treatment/recovery) floor. Keyframe coordinates are in the
 * template's local 1000x1000 SVG viewBox (see HospitalEmergencyResponse.tsx). */
const PATIENT_JOURNEY_KEYFRAMES: Array<{ t: number } & PathPoint> = [
  { t: 0, x: 340, y: 190 },
  { t: 0.15, x: 420, y: 210 },
  { t: 0.35, x: 560, y: 300 },
  { t: 0.5, x: 470, y: 470 },
  { t: 0.7, x: 430, y: 640 },
  { t: 0.85, x: 470, y: 720 },
  { t: 1.0, x: 620, y: 740 }
]

export interface PatientPose extends PathPoint {
  isWalking: boolean
  isDescending: boolean
  facing: -1 | 1
}

export function getPatientJourneyPose(journeyProgress: number): PatientPose {
  const p = clampProgress(journeyProgress)
  const pos = interpolatePath(PATIENT_JOURNEY_KEYFRAMES, p)
  const isDescending = (p > 0.15 && p < 0.35) || (p > 0.5 && p < 0.85)
  const isWalking = p > 0 && p < 1
  return { ...pos, isWalking, isDescending, facing: 1 }
}
