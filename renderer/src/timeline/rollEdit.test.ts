import { describe, expect, it } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { canRollEdit, rollEdit } from './rollEdit'

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, sourceOut: 999, locked: false, ...overrides }
}

function seq(clips: TimelineClip[]): ProjectSequence {
  return { tracks: [], clips, markers: [], duration: 100 }
}

describe('canRollEdit', () => {
  it('is true for two adjacent unlocked clips on the same track', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 })]
    expect(canRollEdit(clips, 'a', 'b')).toBe(true)
  })
  it('is false when there is a gap between them', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 6, duration: 5 })]
    expect(canRollEdit(clips, 'a', 'b')).toBe(false)
  })
  it('is false when either clip is locked', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, locked: true }), clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 })]
    expect(canRollEdit(clips, 'a', 'b')).toBe(false)
  })
  it('is false when the clips are on different tracks', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'A1', startTime: 5, duration: 5 })]
    expect(canRollEdit(clips, 'a', 'b')).toBe(false)
  })
})

describe('rollEdit', () => {
  it('moves the shared boundary, keeping right clip end fixed and no gap/overlap', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, sourceIn: 0 }),
      clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5, sourceIn: 0 })
    ]
    const result = rollEdit(seq(clips), 'a', 'b', 7, { a: 100, b: 100 })
    const a = result.clips.find((c) => c.id === 'a')!
    const b = result.clips.find((c) => c.id === 'b')!
    expect(a.startTime + a.duration).toBeCloseTo(7, 6)
    expect(b.startTime).toBeCloseTo(7, 6)
    expect(b.startTime + b.duration).toBeCloseTo(10, 6) // right clip's own end unchanged
  })

  it('clamps so neither clip shrinks below the minimum duration', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 })]
    const result = rollEdit(seq(clips), 'a', 'b', 100, { a: 100, b: 100 })
    const b = result.clips.find((c) => c.id === 'b')!
    expect(b.duration).toBeGreaterThan(0)
  })

  it('is a no-op when the clips are not adjacent', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 8, duration: 5 })]
    const original = seq(clips)
    expect(rollEdit(original, 'a', 'b', 6)).toBe(original)
  })
})
