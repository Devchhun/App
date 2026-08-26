import { describe, expect, it } from 'vitest'
import { findNonOverlappingStart } from './sceneTimelinePlacement'

describe('findNonOverlappingStart', () => {
  it('returns the desired start unchanged when nothing overlaps', () => {
    expect(findNonOverlappingStart([], 5, 3)).toBe(5)
    expect(findNonOverlappingStart([{ startTime: 0, endTime: 3 }], 10, 3)).toBe(10)
  })

  it('clamps a negative desired start to 0', () => {
    expect(findNonOverlappingStart([], -4, 3)).toBe(0)
  })

  it('pushes past a single colliding range to start right where it ends', () => {
    // New clip [0,3) directly collides with an existing [0,3) clip on the same track.
    expect(findNonOverlappingStart([{ startTime: 0, endTime: 3 }], 0, 3)).toBe(3)
  })

  it('pushes past a partial overlap', () => {
    // Existing [0,3); desired [2,5) overlaps the tail of it.
    expect(findNonOverlappingStart([{ startTime: 0, endTime: 3 }], 2, 3)).toBe(3)
  })

  it('does not treat back-to-back (touching) ranges as overlapping', () => {
    expect(findNonOverlappingStart([{ startTime: 0, endTime: 3 }], 3, 3)).toBe(3)
  })

  it('chains past multiple back-to-back existing clips', () => {
    const existing = [
      { startTime: 0, endTime: 3 },
      { startTime: 3, endTime: 6 },
      { startTime: 6, endTime: 9 }
    ]
    expect(findNonOverlappingStart(existing, 0, 3)).toBe(9)
  })

  it('lands in a gap between two existing clips when the desired start already fits', () => {
    const existing = [
      { startTime: 0, endTime: 3 },
      { startTime: 10, endTime: 13 }
    ]
    expect(findNonOverlappingStart(existing, 5, 3)).toBe(5)
  })

  it('an empty existing list never blocks placement', () => {
    expect(findNonOverlappingStart([], 0, 3)).toBe(0)
  })

  it('handles unsorted input the same as sorted input', () => {
    const existing = [
      { startTime: 6, endTime: 9 },
      { startTime: 0, endTime: 3 },
      { startTime: 3, endTime: 6 }
    ]
    expect(findNonOverlappingStart(existing, 0, 3)).toBe(9)
  })

  it('queues an unbounded run of Adds strictly one after another with no overlap', () => {
    // Regression for the "add as many templates as I want, never overlapping"
    // requirement -- repeatedly inserting at the same desired start (e.g.
    // always the playhead) must always land after everything already placed.
    let existing: { startTime: number; endTime: number }[] = []
    for (let i = 0; i < 6; i++) {
      const start = findNonOverlappingStart(existing, 0, 3)
      expect(start).toBe(i * 3)
      existing = [...existing, { startTime: start, endTime: start + 3 }]
    }
  })
})
