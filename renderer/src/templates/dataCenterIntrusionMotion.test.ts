import { describe, expect, it } from 'vitest'
import {
  computeEntrancePhases,
  computeExitPhases,
  getRedPacketPosition,
  getBluePacketPosition,
  ENTRANCE_REFERENCE_TOTAL
} from './dataCenterIntrusionMotion'

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

  it('draws floors before servers illuminate, before packets enter', () => {
    const enterDuration = 0.55
    const scale = enterDuration / ENTRANCE_REFERENCE_TOTAL
    const mid = computeEntrancePhases(1.3 * scale, enterDuration)
    expect(mid.floorsDraw).toBeGreaterThan(mid.serversIlluminate)
    expect(mid.serversIlluminate).toBeGreaterThan(mid.redPacketsEnter)
  })

  it('sequences the attack beats in order: attack -> impact -> penetrate -> scan -> track -> shield -> blocked -> restore -> green', () => {
    const enterDuration = 1.0
    const scale = enterDuration / ENTRANCE_REFERENCE_TOTAL
    const sample = (ref: number) => computeEntrancePhases(ref * scale, enterDuration)

    const beats: Array<keyof ReturnType<typeof computeEntrancePhases>> = [
      'packetsAttackFirewall',
      'firewallImpactFlash',
      'packetPenetrates',
      'securityScanActivate',
      'detectionRingTrack',
      'shieldActivate',
      'packetBlocked',
      'firewallRestore',
      'systemsGreen'
    ]
    // Right before the final beat completes, every earlier beat should
    // already read further along (>=) than the one after it.
    const late = sample(5.4)
    for (let i = 0; i < beats.length - 1; i++) {
      expect(late[beats[i]]).toBeGreaterThanOrEqual(late[beats[i + 1]])
    }
  })

  it('scales proportionally with enterDuration -- doubling it doubles the seconds at which a phase completes', () => {
    const short = computeEntrancePhases(0.55, 0.55)
    const long = computeEntrancePhases(1.1, 1.1)
    expect(short.floorsDraw).toBeCloseTo(long.floorsDraw, 5)
    expect(short.systemsGreen).toBeCloseTo(long.systemsGreen, 5)
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

  it('is fully faded at progress 1 and not faded at progress 0', () => {
    const start = computeExitPhases(0)
    expect(start.effectsFade).toBe(0)
    expect(start.accentsFade).toBe(0)
    expect(start.outlineFade).toBe(0)

    const end = computeExitPhases(1)
    expect(end.effectsFade).toBe(1)
    expect(end.accentsFade).toBe(1)
    expect(end.outlineFade).toBe(1)
  })

  it('clamps out-of-range progress', () => {
    expect(computeExitPhases(-1).effectsFade).toBe(0)
    expect(computeExitPhases(2).outlineFade).toBe(1)
  })
})

describe('getRedPacketPosition', () => {
  it('starts off-canvas left and moves rightward/downward toward the firewall', () => {
    const start = getRedPacketPosition(0, false)
    const mid = getRedPacketPosition(0.6, false)
    expect(mid.x).toBeGreaterThan(start.x)
    expect(mid.y).toBeGreaterThan(start.y)
  })

  it('when blocked, never advances past the firewall crack point even if given progress > 0.9', () => {
    const atCrack = getRedPacketPosition(0.9, false)
    const pastCrack = getRedPacketPosition(1.0, false)
    expect(pastCrack).toEqual(atCrack)
  })

  it('when breached, continues past the crack toward the database core', () => {
    const atCrack = getRedPacketPosition(0.9, true)
    const breached = getRedPacketPosition(1.0, true)
    expect(breached.y).toBeGreaterThan(atCrack.y)
  })

  it('is deterministic', () => {
    expect(getRedPacketPosition(0.42, true)).toEqual(getRedPacketPosition(0.42, true))
  })
})

describe('getBluePacketPosition', () => {
  it('never crosses through the firewall attack point (stays on the right/safe side)', () => {
    const mid = getBluePacketPosition(0.5)
    const redAtSameProgress = getRedPacketPosition(0.5, true)
    expect(mid.x).toBeGreaterThan(redAtSameProgress.x)
  })

  it('travels from the top floor to the bottom floor as progress goes 0 -> 1', () => {
    const start = getBluePacketPosition(0)
    const end = getBluePacketPosition(1)
    expect(end.y).toBeGreaterThan(start.y)
  })

  it('clamps out-of-range progress', () => {
    expect(getBluePacketPosition(-1)).toEqual(getBluePacketPosition(0))
    expect(getBluePacketPosition(2)).toEqual(getBluePacketPosition(1))
  })
})
