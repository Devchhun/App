import { describe, expect, it } from 'vitest'
import { resolveSegmentMove, resolveSegmentSetMove } from './segmentMove'
import type { TranscriptSegment } from '@shared/transcription'

const seg = (id: string, startTime: number, endTime: number): TranscriptSegment => ({
  id,
  startTime,
  endTime,
  words: [],
  language: 'km',
  confidence: 1,
  text: id,
  needsReview: false
})

const segments = [seg('a', 0, 2), seg('b', 3, 5), seg('c', 8, 10)]

describe('resolveSegmentMove', () => {
  it('keeps a drop that lands in free space', () => {
    expect(resolveSegmentMove(segments, 'b', 5.5)).toBe(5.5)
    expect(resolveSegmentMove(segments, 'c', 12)).toBe(12)
  })

  it('never lets a caption start before the Timeline', () => {
    expect(resolveSegmentMove([seg('a', 4, 6), seg('b', 8, 10)], 'b', -3)).toBe(0)
  })

  it('nudges a drop off a neighbour to the nearer free side', () => {
    // b (2 s long) dropped at 1.5 overlaps a (0-2): after a is 2 (0.5
    // away), before a is -2 (off the Timeline) -> lands at 2.
    expect(resolveSegmentMove(segments, 'b', 1.5)).toBe(2)
    // c dropped at 4.5 overlaps b (3-5): after b (5) is 0.5 away, before b
    // (1) is 3.5 away -> 5.
    expect(resolveSegmentMove(segments, 'c', 4.5)).toBe(5)
  })

  it('refuses a drop when neither side of what it hit has room', () => {
    // b dropped onto a with c pulled up tight: after a is 2..4 which runs
    // into c at 3.5, before a is off the Timeline.
    const tight = [seg('a', 0, 2), seg('b', 6, 8), seg('c', 3.5, 5)]
    expect(resolveSegmentMove(tight, 'b', 1)).toBeNull()
  })

  it('returns null for an unknown caption', () => {
    expect(resolveSegmentMove(segments, 'zzz', 1)).toBeNull()
  })
})

describe('resolveSegmentSetMove', () => {
  it('returns one shared delta that preserves spacing between selected captions', () => {
    expect(resolveSegmentSetMove(segments, ['b', 'c'], 'b', 5)).toBe(2)
  })

  it('clamps the whole group at the start of the Timeline', () => {
    expect(resolveSegmentSetMove(segments, ['a', 'b'], 'b', -10)).toBe(0)
  })

  it('nudges the whole group away from an unselected caption', () => {
    expect(resolveSegmentSetMove(segments, ['b', 'c'], 'b', 1)).toBe(-1)
  })

  it('returns null when the dragged caption is not in the selected set', () => {
    expect(resolveSegmentSetMove(segments, ['a', 'b'], 'c', 12)).toBeNull()
  })
})
