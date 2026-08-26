import { describe, expect, it } from 'vitest'
import type { TimelineClip } from '@shared/project'
import { shiftClipsFrom, closeGap, findGapsOnTrack } from './reflow'

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, locked: false, ...overrides }
}

describe('shiftClipsFrom', () => {
  it('shifts only clips on the given track starting at/after fromTime', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'c', trackId: 'A1', startTime: 5, duration: 5 })
    ]
    const result = shiftClipsFrom(clips, 'V1', 5, 3)
    expect(result.find((c) => c.id === 'a')!.startTime).toBe(0)
    expect(result.find((c) => c.id === 'b')!.startTime).toBe(8)
    expect(result.find((c) => c.id === 'c')!.startTime).toBe(5)
  })

  it('never shifts a clip below startTime 0', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 2, duration: 5 })]
    expect(shiftClipsFrom(clips, 'V1', 0, -10)[0].startTime).toBe(0)
  })

  it('skips locked clips', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 5, locked: true })]
    expect(shiftClipsFrom(clips, 'V1', 5, 3)[0].startTime).toBe(5)
  })

  it('skips explicitly excluded clip ids', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 5 })]
    expect(shiftClipsFrom(clips, 'V1', 5, 3, new Set(['a']))[0].startTime).toBe(5)
  })
})

describe('closeGap', () => {
  it('pulls everything after the gap left by exactly the gap duration', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }), clip({ id: 'b', trackId: 'V1', startTime: 8, duration: 4 })]
    // gap is [3, 8) -- 5 seconds
    const result = closeGap(clips, 'V1', 3, 8)
    expect(result.find((c) => c.id === 'b')!.startTime).toBe(3)
  })

  it('is a no-op for a non-positive gap', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })]
    expect(closeGap(clips, 'V1', 5, 5)).toEqual(clips)
    expect(closeGap(clips, 'V1', 5, 3)).toEqual(clips)
  })
})

describe('findGapsOnTrack', () => {
  it('finds every gap strictly between clips, ignoring other tracks', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }),
      clip({ id: 'b', trackId: 'V1', startTime: 8, duration: 2 }),
      clip({ id: 'c', trackId: 'V1', startTime: 15, duration: 2 }),
      clip({ id: 'd', trackId: 'A1', startTime: 4, duration: 1 })
    ]
    expect(findGapsOnTrack(clips, 'V1')).toEqual([
      { start: 3, end: 8 },
      { start: 10, end: 15 }
    ])
  })

  it('returns no gaps for a gapless track', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }), clip({ id: 'b', trackId: 'V1', startTime: 3, duration: 3 })]
    expect(findGapsOnTrack(clips, 'V1')).toEqual([])
  })

  it('does not report a gap before the first clip or after the last', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 10, duration: 3 })]
    expect(findGapsOnTrack(clips, 'V1')).toEqual([])
  })

  it('handles overlapping clips by taking the furthest extent seen so far', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }),
      clip({ id: 'b', trackId: 'V1', startTime: 2, duration: 3 }),
      clip({ id: 'c', trackId: 'V1', startTime: 15, duration: 2 })
    ]
    expect(findGapsOnTrack(clips, 'V1')).toEqual([{ start: 10, end: 15 }])
  })
})
