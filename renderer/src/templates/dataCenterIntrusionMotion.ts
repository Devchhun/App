// Pure, deterministic motion logic for the Data Center Cyber Intrusion
// template -- every export here is a pure function of the scene's resolved
// TemplateMotionFrame (see motion.ts). Never Date.now()/setInterval/random.
// Kept separate from the .tsx render so the 12-step entrance choreography,
// the hold-phase loops, and the packet-path interpolation are directly
// unit-testable without rendering, and so seeking the Preview timeline
// always reconstructs the exact same frame.
import { lineDrawProgress } from './motion'

/** The entrance sequence's 12 named beats, each 0-1, ramping across its own
 * window of a fixed reference timeline (see REFERENCE_TOTAL) scaled by
 * `enterDuration / REFERENCE_TOTAL`, so a scene using a shorter/longer enter
 * duration still plays the same relative sequence instead of clipping the
 * tail beats or leaving a dead pause. */
export interface EntrancePhases {
  floorsDraw: number
  serversIlluminate: number
  redPacketsEnter: number
  packetsAttackFirewall: number
  firewallImpactFlash: number
  packetPenetrates: number
  securityScanActivate: number
  detectionRingTrack: number
  shieldActivate: number
  packetBlocked: number
  firewallRestore: number
  systemsGreen: number
}

const REFERENCE_TOTAL = 5.7

function phase(t0: number, t1: number, localTime: number, enterDuration: number): number {
  const scale = enterDuration / REFERENCE_TOTAL
  return lineDrawProgress(localTime, t0 * scale, t1 * scale)
}

export function computeEntrancePhases(localTime: number, enterDuration: number): EntrancePhases {
  const safeEnter = Number.isFinite(enterDuration) && enterDuration > 0 ? enterDuration : 0.01
  const t = Number.isFinite(localTime) ? localTime : 0
  return {
    floorsDraw: phase(0.0, 1.1, t, safeEnter),
    serversIlluminate: phase(0.9, 1.6, t, safeEnter),
    redPacketsEnter: phase(1.5, 2.2, t, safeEnter),
    packetsAttackFirewall: phase(2.1, 2.7, t, safeEnter),
    firewallImpactFlash: phase(2.6, 3.0, t, safeEnter),
    packetPenetrates: phase(2.9, 3.3, t, safeEnter),
    securityScanActivate: phase(3.2, 3.6, t, safeEnter),
    detectionRingTrack: phase(3.5, 4.1, t, safeEnter),
    shieldActivate: phase(3.9, 4.4, t, safeEnter),
    packetBlocked: phase(4.3, 4.7, t, safeEnter),
    firewallRestore: phase(4.6, 5.0, t, safeEnter),
    systemsGreen: phase(4.9, 5.5, t, safeEnter)
  }
}

export { REFERENCE_TOTAL as ENTRANCE_REFERENCE_TOTAL }

export interface ExitPhases {
  /** Attacker/packets/scan effects fade first. */
  effectsFade: number
  /** Then the firewall/shield accents. */
  accentsFade: number
  /** Grid and floor outlines fade last. */
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

/** Malicious (red) packet path: enters from off-canvas left, crosses the top
 * floor, descends to the firewall on the middle floor, and either dissolves
 * at the crack (blocked) or continues to the database core (breached) --
 * see getRedPacketPosition's `breached` param. Keyframe coordinates are in
 * the template's local 1000x1000 SVG viewBox (see DataCenterCyberIntrusion.tsx). */
const RED_PACKET_KEYFRAMES: Array<{ t: number } & PathPoint> = [
  { t: 0, x: 60, y: 250 },
  { t: 0.35, x: 300, y: 268 },
  { t: 0.55, x: 400, y: 400 },
  { t: 0.75, x: 480, y: 490 },
  { t: 0.9, x: 540, y: 500 },
  { t: 1.0, x: 560, y: 720 }
]

/** `progress` is the packet's own 0-1 travel progress (already staggered per
 * packet by the caller). When `breached` is false, callers should stop
 * advancing progress past ~0.9 and fade the packet out there instead of
 * calling this with progress > 0.9 -- the t=1.0 keyframe only ever renders
 * when the attack result is 'breached'. */
export function getRedPacketPosition(progress: number, breached: boolean): PathPoint {
  const capped = breached ? progress : Math.min(progress, 0.9)
  return interpolatePath(RED_PACKET_KEYFRAMES, capped)
}

/** Legitimate (blue) packet path: from the top-floor server racks, around
 * the firewall's safe side, down to the database core -- never crosses the
 * firewall's attack point. Loops continuously during the hold phase. */
const BLUE_PACKET_KEYFRAMES: Array<{ t: number } & PathPoint> = [
  { t: 0, x: 700, y: 260 },
  { t: 0.3, x: 720, y: 460 },
  { t: 0.6, x: 750, y: 560 },
  { t: 1.0, x: 640, y: 740 }
]

export function getBluePacketPosition(progress: number): PathPoint {
  return interpolatePath(BLUE_PACKET_KEYFRAMES, progress)
}
