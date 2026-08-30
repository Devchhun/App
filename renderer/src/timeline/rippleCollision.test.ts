import { describe, it, expect } from 'vitest'
import type { TimelineClip } from '@shared/project'
import { planRippleInsert, extendRippleInsertWithLinkedPartners } from './rippleCollision'

function clip(overrides: Partial<TimelineClip> & { id: string; trackId: string; startTime: number; duration: number }): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, locked: false, ...overrides }
}

describe('planRippleInsert', () => {
  it('fits directly into empty space with no existing clips', () => {
    const plan = planRippleInsert([], 'V1', 10, 5)
    expect(plan.fits).toBe(true)
    expect(plan.pushes.size).toBe(0)
  })

  it('fits directly before the first clip, leaving it untouched', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 10, duration: 5 })]
    const plan = planRippleInsert(clips, 'V1', 0, 5)
    expect(plan.fits).toBe(true)
    expect(plan.pushes.size).toBe(0)
  })

  it('fits into an existing gap between two clips (requirement 3: snap into gap, nothing else moves)', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 15, duration: 5 })]
    // Gap is [5,15) -- a 3s clip dropped at 8 fits entirely inside it.
    const plan = planRippleInsert(clips, 'V1', 8, 3)
    expect(plan.fits).toBe(true)
    expect(plan.pushes.size).toBe(0)
  })

  it('ripples the overlapping clip and everything after it when the gap is too small (requirement 4)', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'b', trackId: 'V1', startTime: 6, duration: 5 }), // gap [5,6) -- only 1s, too small for a 3s clip
      clip({ id: 'c', trackId: 'V1', startTime: 11, duration: 4 })
    ]
    const plan = planRippleInsert(clips, 'V1', 5, 3)
    expect(plan.fits).toBe(false)
    // b pushed to make room for [5,8), c pushed right behind b
    expect(plan.pushes.get('b')).toBe(8)
    expect(plan.pushes.get('c')).toBe(13)
    expect(plan.pushes.get('a')).toBeUndefined()
  })

  it('ripples when the drop lands in the middle of an existing clip, not just a gap', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }), clip({ id: 'b', trackId: 'V1', startTime: 20, duration: 5 })]
    // Insert [3, 7) lands inside clip a's [0,10) span.
    const plan = planRippleInsert(clips, 'V1', 3, 4)
    expect(plan.fits).toBe(false)
    expect(plan.pushes.get('a')).toBe(7)
    // b already starts at 20, well clear of a's new end (17) -- untouched.
    expect(plan.pushes.get('b')).toBeUndefined()
  })

  it('preserves order -- every pushed clip stays in the same relative sequence (requirement 5)', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'c', trackId: 'V1', startTime: 10, duration: 5 })
    ]
    const plan = planRippleInsert(clips, 'V1', 2, 3)
    const bStart = plan.pushes.get('b')!
    const cStart = plan.pushes.get('c')!
    expect(bStart).toBeLessThan(cStart)
  })

  it('never produces an overlap after applying the plan (requirement 6)', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'b', trackId: 'V1', startTime: 4, duration: 3 }), // pre-existing tight case for the test setup
      clip({ id: 'c', trackId: 'V1', startTime: 8, duration: 5 })
    ]
    const plan = planRippleInsert(clips, 'V1', 2, 4)
    const applied = clips.map((c) => (plan.pushes.has(c.id) ? { ...c, startTime: plan.pushes.get(c.id)! } : c))
    const inserted = { start: 2, end: 2 + 4 }
    const all = [inserted, ...applied.map((c) => ({ start: c.startTime, end: c.startTime + c.duration }))].sort((a, b) => a.start - b.start)
    for (let i = 1; i < all.length; i++) {
      expect(all[i].start).toBeGreaterThanOrEqual(all[i - 1].end)
    }
  })

  it('only affects the given track -- clips on other tracks are never in the plan (requirement 7)', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 2, duration: 5 }), clip({ id: 'x', trackId: 'A1', startTime: 2, duration: 5 })]
    const plan = planRippleInsert(clips, 'V1', 0, 4)
    expect(plan.pushes.has('x')).toBe(false)
  })

  it('excludes given clip ids (e.g. the clip being dragged, already handled separately)', () => {
    const clips = [clip({ id: 'dragged', trackId: 'V1', startTime: 5, duration: 3 }), clip({ id: 'other', trackId: 'V1', startTime: 8, duration: 5 })]
    const plan = planRippleInsert(clips, 'V1', 0, 4, new Set(['dragged']))
    expect(plan.pushes.has('dragged')).toBe(false)
    expect(plan.fits).toBe(true) // 'dragged' excluded, [0,4) no longer collides with anything considered
  })

  it('treats a locked clip as an immovable obstacle -- never pushes it, but routes around it', () => {
    const clips = [
      clip({ id: 'locked', trackId: 'V1', startTime: 5, duration: 5, locked: true }),
      clip({ id: 'after', trackId: 'V1', startTime: 10, duration: 5 })
    ]
    const plan = planRippleInsert(clips, 'V1', 4, 3) // would overlap the locked clip
    expect(plan.pushes.has('locked')).toBe(false)
    // 'after' already starts exactly where the locked clip ends -- no push needed.
    expect(plan.pushes.has('after')).toBe(false)
  })
})

describe('extendRippleInsertWithLinkedPartners', () => {
  it('moves a pushed clip\'s linked partner on another track by the same delta (requirement 8)', () => {
    const clips = [
      clip({ id: 'v1clip', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a1clip' }),
      clip({ id: 'a1clip', trackId: 'A1', startTime: 0, duration: 5, linkedClipId: 'v1clip' })
    ]
    const pushes = new Map([['v1clip', 8]]) // pushed right by 8
    const extended = extendRippleInsertWithLinkedPartners(clips, pushes)
    expect(extended.get('a1clip')).toBe(8)
  })

  it('does not overwrite a partner that already collided independently', () => {
    const clips = [
      clip({ id: 'v1clip', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a1clip' }),
      clip({ id: 'a1clip', trackId: 'A1', startTime: 0, duration: 5, linkedClipId: 'v1clip' })
    ]
    const pushes = new Map([
      ['v1clip', 8],
      ['a1clip', 12] // already independently planned to a different position
    ])
    const extended = extendRippleInsertWithLinkedPartners(clips, pushes)
    expect(extended.get('a1clip')).toBe(12)
  })

  it('never moves a locked partner', () => {
    const clips = [
      clip({ id: 'v1clip', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a1clip' }),
      clip({ id: 'a1clip', trackId: 'A1', startTime: 0, duration: 5, linkedClipId: 'v1clip', locked: true })
    ]
    const extended = extendRippleInsertWithLinkedPartners(clips, new Map([['v1clip', 8]]))
    expect(extended.has('a1clip')).toBe(false)
  })
})
