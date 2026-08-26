import { describe, expect, it } from 'vitest'
import {
  computeEntrancePhases,
  computeExitPhases,
  getPatientStatusKey,
  getPatientJourneyPose,
  ENTRANCE_REFERENCE_TOTAL
} from './hospitalResponseMotion'

describe('computeEntrancePhases', () => {
  it('is fully deterministic -- same inputs always produce the same outputs', () => {
    const a = computeEntrancePhases(1.2, 0.55)
    const b = computeEntrancePhases(1.2, 0.55)
    expect(a).toEqual(b)
  })

  it('starts every phase at 0 and reaches 1 by the end of the enter duration', () => {
    const start = computeEntrancePhases(0, 0.55)
    expect(Object.values(start).every((v) => v === 0)).toBe(true)

    const end = computeEntrancePhases(1, 0.55)
    expect(Object.values(end).every((v) => v === 1)).toBe(true)
  })

  it('draws the structure before the patient arrives, before the doctor receives them', () => {
    const enterDuration = 0.55
    const scale = enterDuration / ENTRANCE_REFERENCE_TOTAL
    const mid = computeEntrancePhases(1.4 * scale, enterDuration)
    expect(mid.structureDraw).toBeGreaterThan(mid.patientArrives)
    expect(mid.patientArrives).toBeGreaterThanOrEqual(mid.doctorReceives)
  })

  it('sequences the treatment beats in order: scan -> diagnosis -> treatment -> amber -> recovery -> green', () => {
    const enterDuration = 1.0
    const scale = enterDuration / ENTRANCE_REFERENCE_TOTAL
    const sample = (ref: number) => computeEntrancePhases(ref * scale, enterDuration)

    const beats: Array<keyof ReturnType<typeof computeEntrancePhases>> = [
      'scannerScans',
      'diagnosisTravels',
      'treatmentActivate',
      'statusToAmber',
      'moveToRecovery',
      'heartbeatGreen'
    ]
    const late = sample(5.2)
    for (let i = 0; i < beats.length - 1; i++) {
      expect(late[beats[i]]).toBeGreaterThanOrEqual(late[beats[i + 1]])
    }
  })

  it('scales proportionally with enterDuration', () => {
    const short = computeEntrancePhases(0.55, 0.55)
    const long = computeEntrancePhases(1.1, 1.1)
    expect(short.structureDraw).toBeCloseTo(long.structureDraw, 5)
    expect(short.heartbeatGreen).toBeCloseTo(long.heartbeatGreen, 5)
  })

  it('handles zero/invalid enterDuration without NaN', () => {
    const result = computeEntrancePhases(0.5, 0)
    for (const v of Object.values(result)) {
      expect(Number.isNaN(v)).toBe(false)
    }
  })

  it('clamps out-of-range localTime instead of exceeding [0,1]', () => {
    const negative = computeEntrancePhases(-5, 0.55)
    expect(Object.values(negative).every((v) => v === 0)).toBe(true)

    const huge = computeEntrancePhases(999, 0.55)
    expect(Object.values(huge).every((v) => v === 1)).toBe(true)
  })
})

describe('computeExitPhases', () => {
  it('fades effects, then accents, then outlines', () => {
    const mid = computeExitPhases(0.5)
    expect(mid.effectsFade).toBeGreaterThan(mid.accentsFade)
    expect(mid.accentsFade).toBeGreaterThan(mid.outlineFade)
  })

  it('clamps out-of-range progress', () => {
    expect(computeExitPhases(-1).effectsFade).toBe(0)
    expect(computeExitPhases(2).outlineFade).toBe(1)
  })
})

describe('getPatientStatusKey', () => {
  it('is critical before treatment starts', () => {
    expect(getPatientStatusKey(0, 0)).toBe('critical')
  })

  it('is treatment once statusToAmber has begun but not yet recovered', () => {
    expect(getPatientStatusKey(0.4, 0)).toBe('treatment')
    expect(getPatientStatusKey(1, 0.9)).toBe('treatment')
  })

  it('is recovered once heartbeatGreen completes, regardless of statusToAmber', () => {
    expect(getPatientStatusKey(1, 1)).toBe('recovered')
  })
})

describe('getPatientJourneyPose', () => {
  it('starts on the top floor and ends on the bottom floor', () => {
    const start = getPatientJourneyPose(0)
    const end = getPatientJourneyPose(1)
    expect(end.y).toBeGreaterThan(start.y)
  })

  it('is not walking at the very start or very end (arrived/settled)', () => {
    expect(getPatientJourneyPose(0).isWalking).toBe(false)
    expect(getPatientJourneyPose(1).isWalking).toBe(false)
    expect(getPatientJourneyPose(0.5).isWalking).toBe(true)
  })

  it('is deterministic', () => {
    expect(getPatientJourneyPose(0.42)).toEqual(getPatientJourneyPose(0.42))
  })

  it('clamps out-of-range progress', () => {
    expect(getPatientJourneyPose(-1)).toEqual(getPatientJourneyPose(0))
    expect(getPatientJourneyPose(2)).toEqual(getPatientJourneyPose(1))
  })
})
