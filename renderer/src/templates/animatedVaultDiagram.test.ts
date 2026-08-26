import { describe, it, expect } from 'vitest'
import { computeEntrancePhases, getPersonJourneyPose, computeExitPhases } from './animatedVaultDiagram'

describe('computeEntrancePhases', () => {
  it('is an exact deterministic function of its inputs -- identical localTime/enterDuration always produces an identical result', () => {
    expect(computeEntrancePhases(1.2, 2.5)).toEqual(computeEntrancePhases(1.2, 2.5))
  })

  it('bottom floor draws before middle floor, which draws before top floor (matches the specified bottom-up entrance order)', () => {
    const enterDuration = 4
    const early = computeEntrancePhases(0.7, enterDuration)
    expect(early.bottomFloorDraw).toBeGreaterThan(early.middleFloorDraw)
    expect(early.middleFloorDraw).toBeGreaterThan(early.topFloorDraw)
  })

  it('every phase reaches 1 (fully complete) once the entrance window ends, and stays there', () => {
    const enterDuration = 2
    const finished = computeEntrancePhases(enterDuration * 2, enterDuration)
    expect(finished.glow).toBe(1)
    expect(finished.bottomFloorDraw).toBe(1)
    expect(finished.topFloorDraw).toBe(1)
    expect(finished.personJourney).toBe(1)
  })

  it('nothing has started before localTime 0', () => {
    const phases = computeEntrancePhases(0, 2)
    expect(phases.glow).toBe(0)
    expect(phases.personJourney).toBe(0)
  })

  it('scales proportionally with enterDuration -- a shorter enter window still plays the same relative sequence', () => {
    const short = computeEntrancePhases(0.5, 1) // halfway through a 1s entrance
    const long = computeEntrancePhases(1, 2) // halfway through a 2s entrance (same relative position)
    expect(short.bottomFloorDraw).toBeCloseTo(long.bottomFloorDraw, 5)
    expect(short.personJourney).toBeCloseTo(long.personJourney, 5)
  })

  it('handles a zero/invalid enterDuration without producing NaN or Infinity', () => {
    const phases = computeEntrancePhases(1, 0)
    for (const value of Object.values(phases)) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('getPersonJourneyPose', () => {
  it('starts on the top floor and ends on the vault floor', () => {
    const start = getPersonJourneyPose(0)
    const end = getPersonJourneyPose(1)
    expect(start.y).toBeLessThan(400)
    expect(end.y).toBeGreaterThan(700)
  })

  it('is walking while actively moving between two different keyframes', () => {
    expect(getPersonJourneyPose(0.1).isWalking).toBe(true)
  })

  it('pauses before the laser barrier (identical position held across that window)', () => {
    const a = getPersonJourneyPose(0.32)
    const b = getPersonJourneyPose(0.41)
    expect(a.isWalking).toBe(false)
    expect(a.x).toBeCloseTo(b.x, 5)
    expect(a.y).toBeCloseTo(b.y, 5)
  })

  it('is descending on both staircase segments', () => {
    expect(getPersonJourneyPose(0.1).isDescending).toBe(true) // first staircase
    expect(getPersonJourneyPose(0.75).isDescending).toBe(true) // second staircase
    expect(getPersonJourneyPose(0.5).isDescending).toBe(false) // crossing the lasers, not on stairs
  })

  it('is deterministic and reversible -- the same progress value always yields the same pose regardless of scrub direction', () => {
    const forward = [0.1, 0.3, 0.5, 0.7, 0.9].map(getPersonJourneyPose)
    const backward = [0.9, 0.7, 0.5, 0.3, 0.1].map(getPersonJourneyPose)
    expect(forward.map((p) => [p.x, p.y])).toEqual(backward.slice().reverse().map((p) => [p.x, p.y]))
  })

  it('clamps out-of-range progress instead of extrapolating', () => {
    expect(getPersonJourneyPose(-1)).toEqual(getPersonJourneyPose(0))
    expect(getPersonJourneyPose(2)).toEqual(getPersonJourneyPose(1))
  })
})

describe('computeExitPhases', () => {
  it('internals fade first, then lasers retract, then the outline fades last', () => {
    const early = computeExitPhases(0.4)
    expect(early.internalsFade).toBeGreaterThan(early.laserRetract)
    expect(early.laserRetract).toBeGreaterThan(early.outlineFade)
  })

  it('everything is fully faded by the end of the exit window', () => {
    const done = computeExitPhases(1)
    expect(done.internalsFade).toBe(1)
    expect(done.laserRetract).toBe(1)
    expect(done.outlineFade).toBe(1)
  })

  it('nothing is faded before the exit window begins', () => {
    const start = computeExitPhases(0)
    expect(start.internalsFade).toBe(0)
    expect(start.laserRetract).toBe(0)
    expect(start.outlineFade).toBe(0)
  })
})
