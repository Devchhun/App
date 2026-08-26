import { describe, it, expect } from 'vitest'
import { partitionSegmentsForRegeneration, mergeSuggestions, spliceSuggestion } from './mergeSuggestions'
import type { AiSuggestion } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'

function makeSegment(id: string, startTime: number): TranscriptSegment {
  return {
    id,
    words: [],
    startTime,
    endTime: startTime + 1,
    language: 'en',
    confidence: 0.9,
    text: `text-${id}`,
    needsReview: false
  }
}

function makeSuggestion(overrides: Partial<AiSuggestion> & { segmentId: string; startTime: number }): AiSuggestion {
  return {
    id: `sugg-${overrides.segmentId}`,
    mediaId: 'media-1',
    endTime: overrides.startTime + 1,
    purpose: 'main_claim',
    originalText: 'original',
    visualText: 'visual',
    reason: 'reason',
    confidence: 0.8,
    status: 'suggested',
    locked: false,
    edited: false,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('partitionSegmentsForRegeneration', () => {
  it('preserves accepted, locked, and edited suggestions; sends everything else to classify', () => {
    const segments = [makeSegment('a', 0), makeSegment('b', 1), makeSegment('c', 2), makeSegment('d', 3), makeSegment('e', 4)]
    const existing = [
      makeSuggestion({ segmentId: 'a', startTime: 0, status: 'accepted' }),
      makeSuggestion({ segmentId: 'b', startTime: 1, locked: true }),
      makeSuggestion({ segmentId: 'c', startTime: 2, edited: true }),
      makeSuggestion({ segmentId: 'd', startTime: 3, status: 'rejected' }), // rejected but not locked/edited -> re-classify
      makeSuggestion({ segmentId: 'e', startTime: 4, status: 'suggested' }) // plain suggestion -> re-classify
    ]

    const { toPreserve, toClassify } = partitionSegmentsForRegeneration(segments, existing)

    expect(toPreserve.map((s) => s.segmentId).sort()).toEqual(['a', 'b', 'c'])
    expect(toClassify.map((s) => s.id).sort()).toEqual(['d', 'e'])
  })

  it('sends segments with no existing suggestion to classify', () => {
    const segments = [makeSegment('new', 10)]
    const { toPreserve, toClassify } = partitionSegmentsForRegeneration(segments, [])
    expect(toPreserve).toEqual([])
    expect(toClassify.map((s) => s.id)).toEqual(['new'])
  })
})

describe('mergeSuggestions', () => {
  it('combines preserved and fresh suggestions in timeline order', () => {
    const preserved = [makeSuggestion({ segmentId: 'b', startTime: 5 })]
    const fresh = [makeSuggestion({ segmentId: 'a', startTime: 1 }), makeSuggestion({ segmentId: 'c', startTime: 9 })]
    const merged = mergeSuggestions(preserved, fresh)
    expect(merged.map((s) => s.segmentId)).toEqual(['a', 'b', 'c'])
  })
})

describe('spliceSuggestion', () => {
  it('replaces the suggestion for the matching segment without disturbing others', () => {
    const existing = [
      makeSuggestion({ segmentId: 'a', startTime: 0, visualText: 'old-a' }),
      makeSuggestion({ segmentId: 'b', startTime: 1, visualText: 'old-b' })
    ]
    const updated = makeSuggestion({ segmentId: 'a', startTime: 0, visualText: 'new-a' })
    const result = spliceSuggestion(existing, updated)
    expect(result).toHaveLength(2)
    expect(result.find((s) => s.segmentId === 'a')?.visualText).toBe('new-a')
    expect(result.find((s) => s.segmentId === 'b')?.visualText).toBe('old-b')
  })

  it('appends when there was no existing suggestion for that segment', () => {
    const existing = [makeSuggestion({ segmentId: 'a', startTime: 0 })]
    const updated = makeSuggestion({ segmentId: 'z', startTime: 5 })
    const result = spliceSuggestion(existing, updated)
    expect(result.map((s) => s.segmentId)).toEqual(['a', 'z'])
  })
})
