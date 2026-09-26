import { describe, it, expect } from 'vitest'
import { findNextPendingSegment } from './narrationSelection'
import type { TranscriptSegment } from '@shared/transcription'
import type { NarrationSegmentState } from '@shared/narration'

function segment(id: string, startTime: number): TranscriptSegment {
  return { id, words: [], startTime, endTime: startTime + 2, language: 'auto', confidence: 1, text: id, needsReview: false }
}

function accepted(segmentId: string): NarrationSegmentState {
  return { segmentId, status: 'accepted', speaker: 'unknown', takes: [] }
}

describe('findNextPendingSegment (Accept & Next advancement)', () => {
  const segments = [segment('a', 0), segment('b', 2), segment('c', 4), segment('d', 6)]

  it('advances to the very next segment when it is not yet accepted', () => {
    const next = findNextPendingSegment(segments, 0, {})
    expect(next?.id).toBe('b')
  })

  it('skips over already-accepted segments to find the next pending one', () => {
    const states = { b: accepted('b'), c: accepted('c') }
    const next = findNextPendingSegment(segments, 0, states)
    expect(next?.id).toBe('d')
  })

  it('does not skip a "recorded" (reviewed but not yet accepted) or "needs-review" segment', () => {
    const states: Record<string, NarrationSegmentState> = {
      b: { segmentId: 'b', status: 'recorded', speaker: 'unknown', takes: [] }
    }
    expect(findNextPendingSegment(segments, 0, states)?.id).toBe('b')
  })

  it('returns null once every remaining segment is already accepted', () => {
    const states = { b: accepted('b'), c: accepted('c'), d: accepted('d') }
    expect(findNextPendingSegment(segments, 0, states)).toBeNull()
  })

  it('returns null at the last segment -- never wraps around to the start', () => {
    expect(findNextPendingSegment(segments, segments.length - 1, {})).toBeNull()
  })

  it('returns null for an empty segment list', () => {
    expect(findNextPendingSegment([], -1, {})).toBeNull()
  })
})
