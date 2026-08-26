import { describe, expect, it } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { findGapAt, removeGap, removeAllGapsOnTrack, insertGapAt } from './gapOps'

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, locked: false, ...overrides }
}

function seq(clips: TimelineClip[]): ProjectSequence {
  return { tracks: [], clips, markers: [], duration: 100 }
}

describe('findGapAt', () => {
  it('finds the gap containing the given time', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }), clip({ id: 'b', trackId: 'V1', startTime: 8, duration: 2 })])
    expect(findGapAt(s, 'V1', 5)).toEqual({ start: 3, end: 8 })
  })
  it('returns null when the time is inside a clip', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 })])
    expect(findGapAt(s, 'V1', 1)).toBeNull()
  })
  it('returns null before the first or after the last clip', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 3 })])
    expect(findGapAt(s, 'V1', 1)).toBeNull()
    expect(findGapAt(s, 'V1', 20)).toBeNull()
  })
})

describe('removeGap', () => {
  it('shifts everything after the gap left by the gap duration', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }), clip({ id: 'b', trackId: 'V1', startTime: 8, duration: 2 })])
    const result = removeGap(s, 'V1', 3, 8)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(3)
  })
})

describe('removeAllGapsOnTrack', () => {
  it('closes every gap on the track, leaving it fully gapless', () => {
    const s = seq([
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 2 }),
      clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 2 }),
      clip({ id: 'c', trackId: 'V1', startTime: 12, duration: 2 })
    ])
    const result = removeAllGapsOnTrack(s, 'V1')
    const ordered = result.clips.sort((x, y) => x.startTime - y.startTime)
    expect(ordered[0].startTime).toBe(0)
    expect(ordered[1].startTime).toBe(2)
    expect(ordered[2].startTime).toBe(4)
  })

  it('leaves other tracks untouched', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 2 }), clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 2 }), clip({ id: 'x', trackId: 'A1', startTime: 5, duration: 2 })])
    const result = removeAllGapsOnTrack(s, 'V1')
    expect(result.clips.find((c) => c.id === 'x')!.startTime).toBe(5)
  })
})

describe('insertGapAt', () => {
  it('pushes clips at/after atTime right by gapDuration', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 2 })])
    const result = insertGapAt(s, 'V1', 5, 3)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(8)
  })
  it('is a no-op for a non-positive gap duration', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 2 })])
    expect(insertGapAt(s, 'V1', 5, 0)).toBe(s)
  })
})
