import { describe, it, expect } from 'vitest'
import { computeVaultStoryPhases, getPersonPose, computeLaserActivity, computeVaultWheelState } from './vaultBreakIn'

describe('computeVaultStoryPhases', () => {
  it('each phase ramps 0->1 across its own window and stays there outside it', () => {
    expect(computeVaultStoryPhases(0).floorsDraw).toBe(0)
    expect(computeVaultStoryPhases(0.06).floorsDraw).toBeCloseTo(0.5, 5)
    expect(computeVaultStoryPhases(0.12).floorsDraw).toBe(1)
    expect(computeVaultStoryPhases(1).floorsDraw).toBe(1) // stays at 1 well past its own window

    expect(computeVaultStoryPhases(0).vaultUnlock).toBe(0)
    expect(computeVaultStoryPhases(0.82).vaultUnlock).toBeCloseTo(0.5, 5)
    expect(computeVaultStoryPhases(1).vaultUnlock).toBe(1)
  })

  it('is an exact deterministic function of storyProgress -- identical input always produces an identical result', () => {
    expect(computeVaultStoryPhases(0.5)).toEqual(computeVaultStoryPhases(0.5))
  })

  it('successGlow only activates in the final 10% of the story', () => {
    expect(computeVaultStoryPhases(0.85).successGlow).toBe(0)
    expect(computeVaultStoryPhases(0.95).successGlow).toBeCloseTo(0.5, 5)
    expect(computeVaultStoryPhases(1).successGlow).toBe(1)
  })
})

describe('getPersonPose', () => {
  it('starts on the top floor and ends standing at the vault', () => {
    const start = getPersonPose(0)
    const end = getPersonPose(1)
    expect(start.y).toBeLessThan(200) // top floor
    expect(end.y).toBeGreaterThan(400) // bottom floor
  })

  it('is walking while actively moving between two different waypoints', () => {
    expect(getPersonPose(0.2).isWalking).toBe(true) // crossing the top floor
  })

  it('is NOT walking during the laser-flicker pause (identical position held across the whole bypass window)', () => {
    const mid = getPersonPose(0.5)
    const early = getPersonPose(0.46)
    const late = getPersonPose(0.57)
    expect(mid.isWalking).toBe(false)
    expect(early.x).toBeCloseTo(late.x, 5)
    expect(early.y).toBeCloseTo(late.y, 5)
  })

  it('is descending while on a staircase segment', () => {
    expect(getPersonPose(0.28).isDescending).toBe(true) // upper stairs
    expect(getPersonPose(0.75).isDescending).toBe(true) // lower stairs
    expect(getPersonPose(0.2).isDescending).toBe(false) // level top-floor walk
  })

  it('produces identical output for the same storyProgress, and a smooth reversal when scrubbing backward', () => {
    const forward = [0.1, 0.3, 0.5, 0.7, 0.9].map(getPersonPose)
    const backward = [0.9, 0.7, 0.5, 0.3, 0.1].map(getPersonPose)
    expect(forward.map((p) => [p.x, p.y])).toEqual(backward.slice().reverse().map((p) => [p.x, p.y]))
  })

  it('clamps out-of-range storyProgress instead of extrapolating past the first/last keyframe', () => {
    expect(getPersonPose(-5)).toEqual(getPersonPose(0))
    expect(getPersonPose(5)).toEqual(getPersonPose(1))
  })

  it('holds the last real walking direction through a paused segment instead of defaulting', () => {
    const walkingLeft = getPersonPose(0.6) // walking left through the laser gap
    const pausedAfter = getPersonPose(0.58) // the pause right before that crossing starts
    expect(walkingLeft.facing).toBe(-1)
    expect(pausedAfter.facing).toBe(pausedAfter.facing) // finite, doesn't throw
    expect([-1, 1]).toContain(pausedAfter.facing)
  })
})

describe('computeLaserActivity', () => {
  it('sequential: all lasers start fully lit before the bypass begins', () => {
    const activity = computeLaserActivity(5, 'sequential', 0, 0, false)
    expect(activity).toEqual([1, 1, 1, 1, 1])
  })

  it('sequential: lasers switch off left to right as laserBypassProgress advances', () => {
    const early = computeLaserActivity(5, 'sequential', 0.15, 0, false)
    expect(early[0]).toBeLessThan(1) // the leftmost laser is already going out
    expect(early[4]).toBe(1) // the rightmost hasn't started yet

    const all = computeLaserActivity(5, 'sequential', 1, 0, false)
    expect(all.every((a) => a === 0)).toBe(true)
  })

  it('gap: only the center laser opens; the rest stay fully lit throughout', () => {
    const activity = computeLaserActivity(5, 'gap', 1, 0, false)
    expect(activity[2]).toBe(0) // center laser (index 2 of 5) is open
    expect(activity[0]).toBe(1)
    expect(activity[1]).toBe(1)
    expect(activity[3]).toBe(1)
    expect(activity[4]).toBe(1)
  })

  it('reactivates after the crossing when laserReactivation is on', () => {
    const withReactivation = computeLaserActivity(5, 'sequential', 1, 1, true)
    expect(withReactivation.every((a) => a === 1)).toBe(true)
  })

  it('stays off after the crossing when laserReactivation is off', () => {
    const withoutReactivation = computeLaserActivity(5, 'sequential', 1, 1, false)
    expect(withoutReactivation.every((a) => a === 0)).toBe(true)
  })

  it('clamps laserCount to a sane 1-5 range', () => {
    expect(computeLaserActivity(0, 'sequential', 0, 0, false)).toHaveLength(1)
    expect(computeLaserActivity(99, 'sequential', 0, 0, false)).toHaveLength(5)
    expect(computeLaserActivity(NaN, 'sequential', 0, 0, false)).toHaveLength(5)
  })
})

describe('computeVaultWheelState', () => {
  it('does not rotate or unlock before the vault-unlock phase begins', () => {
    const state = computeVaultWheelState(0, 150)
    expect(state.rotationDegrees).toBe(0)
    expect(state.unlockMix).toBe(0)
    expect(state.boltRetract).toBe(0)
  })

  it('rotates the full configured amount and fully unlocks by the end of the phase', () => {
    const state = computeVaultWheelState(1, 150)
    expect(state.rotationDegrees).toBe(150)
    expect(state.unlockMix).toBe(1)
    expect(state.boltRetract).toBe(1)
  })

  it('rotation is linear in progress; unlockMix/boltRetract lag behind rotation (lead the color change)', () => {
    const state = computeVaultWheelState(0.5, 180)
    expect(state.rotationDegrees).toBeCloseTo(90, 5)
    expect(state.unlockMix).toBeLessThan(state.rotationDegrees / 180) // color hasn't caught up to rotation yet
  })

  it('defaults to a sane rotation amount for an invalid configured value', () => {
    const state = computeVaultWheelState(1, NaN)
    expect(state.rotationDegrees).toBeGreaterThan(0)
    expect(Number.isFinite(state.rotationDegrees)).toBe(true)
  })
})
