// Pure, deterministic story logic for the Vault Break-In Animation template
// -- every export here is a pure function of `storyProgress` (0-1 across the
// WHOLE scene duration: `frame.localTime / frame.duration`), never wall-clock
// time. Kept separate from the .tsx render so the walking path, laser
// bypass, and vault-unlock math are directly unit-testable without
// rendering, and so seeking the Preview timeline always reconstructs the
// exact same frame -- the render component only turns these numbers into
// SVG/CSS.
import { remap } from './animation'

/** 0-1 progress within each named beat of the story, derived from ONE
 * overall `storyProgress` (0-1 across the scene's full duration) via the
 * spec's suggested normalized sequence. Each field ramps 0->1 across its own
 * window and stays at its boundary value outside it (via `remap`'s clamp),
 * so every phase's visuals are always in a valid, deterministic state
 * regardless of where the timeline is scrubbed to. */
export interface VaultStoryPhases {
  /** 0-12%: floors and grids draw in. */
  floorsDraw: number
  /** 12-30%: person walks across the top floor and descends the upper stairs. */
  walkUpper: number
  /** 30-45%: person steps onto the middle floor and approaches the lasers. */
  approachLasers: number
  /** 45-58%: person pauses; lasers flicker and disable (bypass). */
  laserBypass: number
  /** 58-74%: person crosses, walks to the lower stairs, and descends. */
  crossAndDescend: number
  /** 74-90%: person arrives at the vault; the wheel rotates and unlocks. */
  vaultUnlock: number
  /** 90-100%: success glow and title emphasis. */
  successGlow: number
}

export function computeVaultStoryPhases(storyProgress: number): VaultStoryPhases {
  return {
    floorsDraw: remap(storyProgress, 0, 0.12),
    walkUpper: remap(storyProgress, 0.12, 0.3),
    approachLasers: remap(storyProgress, 0.3, 0.45),
    laserBypass: remap(storyProgress, 0.45, 0.58),
    crossAndDescend: remap(storyProgress, 0.58, 0.74),
    vaultUnlock: remap(storyProgress, 0.74, 0.9),
    successGlow: remap(storyProgress, 0.9, 1)
  }
}

export interface PersonPose {
  x: number
  y: number
  /** True while actively moving between two different waypoints (drives the
   * walk cycle); false while paused/standing (laser pause, vault arrival). */
  isWalking: boolean
  /** True while descending a staircase -- used to tilt the figure slightly
   * and shorten its stride, distinguishing a descent from level walking. */
  isDescending: boolean
  /** -1 = facing/moving left, 1 = facing/moving right. Held from the last
   * real movement during a paused segment instead of snapping to a default. */
  facing: -1 | 1
}

/** The whole journey as ordered (storyProgress, x, y, descending) keyframes
 * in local diagram-space units (matches the SVG viewBox the template
 * renders, see VAULT_VIEWBOX in VaultBreakInAnimation.tsx). A story-progress
 * value between two keyframes linearly interpolates x/y; a keyframe pair
 * with identical x/y is a deliberate pause (laser flicker, vault arrival). */
const PERSON_KEYFRAMES: Array<{ t: number; x: number; y: number; descending: boolean }> = [
  { t: 0.0, x: 110, y: 90, descending: false }, // appears on the top floor
  { t: 0.12, x: 110, y: 90, descending: false }, // floors finish drawing in
  { t: 0.22, x: 250, y: 90, descending: false }, // walks across the top floor
  { t: 0.3, x: 270, y: 300, descending: true }, // descends the upper stairs
  { t: 0.38, x: 270, y: 320, descending: false }, // steps onto the middle floor
  { t: 0.45, x: 230, y: 320, descending: false }, // approaches the laser barrier
  { t: 0.58, x: 230, y: 320, descending: false }, // pauses through the whole bypass sequence
  { t: 0.66, x: 110, y: 320, descending: false }, // walks through the opened gap
  { t: 0.7, x: 130, y: 340, descending: false }, // approaches the lower stairs
  { t: 0.74, x: 150, y: 550, descending: true }, // descends to the bottom floor
  { t: 0.8, x: 250, y: 550, descending: false }, // walks to the vault wheel
  { t: 1.0, x: 250, y: 550, descending: false } // stands at the vault (wheel animates independently)
]

/** Deterministic position/pose for the human figure at any storyProgress --
 * pure linear interpolation between the two surrounding keyframes above, so
 * scrubbing to any timestamp reconstructs the exact same pose. */
export function getPersonPose(storyProgress: number): PersonPose {
  const t = Math.max(0, Math.min(1, Number.isFinite(storyProgress) ? storyProgress : 0))

  let segStart = PERSON_KEYFRAMES[0]
  let segEnd = PERSON_KEYFRAMES[PERSON_KEYFRAMES.length - 1]
  for (let i = 0; i < PERSON_KEYFRAMES.length - 1; i++) {
    if (t >= PERSON_KEYFRAMES[i].t && t <= PERSON_KEYFRAMES[i + 1].t) {
      segStart = PERSON_KEYFRAMES[i]
      segEnd = PERSON_KEYFRAMES[i + 1]
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

/** Looks backward through the keyframe list for the last segment with real
 * horizontal movement, so a paused segment (dx=0) keeps facing whichever
 * direction the person was last walking instead of defaulting to a fixed side. */
function lastFacingBefore(t: number): -1 | 1 {
  for (let i = PERSON_KEYFRAMES.length - 2; i >= 0; i--) {
    if (PERSON_KEYFRAMES[i].t > t) continue
    const dx = PERSON_KEYFRAMES[i + 1].x - PERSON_KEYFRAMES[i].x
    if (dx !== 0) return dx < 0 ? -1 : 1
  }
  return 1
}

export type BypassStyle = 'sequential' | 'gap'

/** Per-laser activity (1 = fully lit, 0 = fully off), one entry per laser
 * index. 'sequential': lasers switch off left-to-right, one after another,
 * across `laserBypassProgress`. 'gap': only the center laser opens; the
 * others stay lit throughout. After `crossAndDescendProgress` advances (the
 * person has had time to fully cross), lasers ramp back on if
 * `laserReactivation` is set -- otherwise they stay off for the rest of the
 * scene, matching "may reactivate after the person crosses." */
export function computeLaserActivity(
  laserCount: number,
  bypassStyle: BypassStyle,
  laserBypassProgress: number,
  crossAndDescendProgress: number,
  laserReactivation: boolean
): number[] {
  const count = Math.max(1, Math.min(5, Math.round(Number.isFinite(laserCount) ? laserCount : 5)))
  const reactivateProgress = laserReactivation ? remap(crossAndDescendProgress, 0.55, 1) : 0

  if (bypassStyle === 'gap') {
    const centerIndex = Math.floor(count / 2)
    const gapOpen = remap(laserBypassProgress, 0, 0.6)
    return Array.from({ length: count }, (_, i) => {
      if (i !== centerIndex) return 1
      return Math.max(1 - gapOpen, reactivateProgress)
    })
  }

  return Array.from({ length: count }, (_, i) => {
    const offWindowStart = i / count
    const offWindowEnd = (i + 1) / count
    const off = remap(laserBypassProgress, offWindowStart, offWindowEnd)
    return Math.max(1 - off, reactivateProgress)
  })
}

export interface VaultWheelState {
  /** Degrees rotated so far (0 at the start of the unlock phase). */
  rotationDegrees: number
  /** 0 = fully locked (cyan/red), 1 = fully unlocked (green). */
  unlockMix: number
  /** 0 = bolts fully extended/locked, 1 = bolts fully retracted. */
  boltRetract: number
}

/** Deterministic vault-wheel state from `vaultUnlockProgress` (0-1) and the
 * configured total rotation -- rotation and bolt retraction lead the color
 * crossfade slightly (the wheel visibly turns and the bolts visibly pull
 * back before the "locked" glow fully gives way to "unlocked"). */
export function computeVaultWheelState(vaultUnlockProgress: number, wheelRotationDegrees: number): VaultWheelState {
  const totalRotation = Number.isFinite(wheelRotationDegrees) ? Math.max(0, wheelRotationDegrees) : 150
  return {
    rotationDegrees: vaultUnlockProgress * totalRotation,
    unlockMix: remap(vaultUnlockProgress, 0.55, 1),
    boltRetract: remap(vaultUnlockProgress, 0.25, 0.85)
  }
}
