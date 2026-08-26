import { describe, expect, it } from 'vitest'
import { mergeStoryBeats, splitStoryBeat } from './storyBeatOps'
import type { StoryBeat } from '@shared/story'

function beat(overrides: Partial<StoryBeat> = {}): StoryBeat {
  return {
    id: 'beat-1',
    startTime: 0,
    endTime: 10,
    segmentIds: ['seg-1', 'seg-2'],
    title: 'Beat One',
    summary: 'First summary.',
    purpose: 'introduces the question',
    entities: ['entity-wang-lin'],
    relations: [],
    recommendedVisualization: 'central-identity',
    importance: 'important',
    ...overrides
  }
}

describe('mergeStoryBeats', () => {
  it('keeps the first beat id/title/recommendedVisualization', () => {
    const a = beat({ id: 'beat-a', title: 'Opening' })
    const b = beat({ id: 'beat-b', title: 'Continuation', startTime: 10, endTime: 20 })
    const merged = mergeStoryBeats(a, b)
    expect(merged.id).toBe('beat-a')
    expect(merged.title).toBe('Opening')
    expect(merged.recommendedVisualization).toBe('central-identity')
  })

  it('spans the full time range and unions segmentIds/entities/relations without duplicates', () => {
    const a = beat({ startTime: 0, endTime: 10, segmentIds: ['seg-1', 'seg-2'], entities: ['e1'], relations: ['r1'] })
    const b = beat({ startTime: 10, endTime: 20, segmentIds: ['seg-2', 'seg-3'], entities: ['e1', 'e2'], relations: ['r2'] })
    const merged = mergeStoryBeats(a, b)
    expect(merged.startTime).toBe(0)
    expect(merged.endTime).toBe(20)
    expect(merged.segmentIds).toEqual(['seg-1', 'seg-2', 'seg-3'])
    expect(merged.entities).toEqual(['e1', 'e2'])
    expect(merged.relations).toEqual(['r1', 'r2'])
  })

  it('concatenates summaries from both beats', () => {
    const merged = mergeStoryBeats(beat({ summary: 'Part A.' }), beat({ summary: 'Part B.' }))
    expect(merged.summary).toBe('Part A. Part B.')
  })

  it('keeps the higher importance of the two', () => {
    const merged = mergeStoryBeats(beat({ importance: 'supporting' }), beat({ importance: 'critical' }))
    expect(merged.importance).toBe('critical')
  })

  it('unions evidence, or leaves it undefined when neither beat has any', () => {
    const withEvidence = mergeStoryBeats(beat({ evidence: ['Chapter 1'] }), beat({ evidence: ['Chapter 1', 'Chapter 2'] }))
    expect(withEvidence.evidence).toEqual(['Chapter 1', 'Chapter 2'])
    const withoutEvidence = mergeStoryBeats(beat({ evidence: undefined }), beat({ evidence: undefined }))
    expect(withoutEvidence.evidence).toBeUndefined()
  })
})

describe('splitStoryBeat', () => {
  const segmentTimes = {
    'seg-1': { startTime: 0, endTime: 3 },
    'seg-2': { startTime: 3, endTime: 6 },
    'seg-3': { startTime: 6, endTime: 9 },
    'seg-4': { startTime: 9, endTime: 12 }
  }

  it('returns null when atTime is outside the beat range', () => {
    const b = beat({ startTime: 0, endTime: 10 })
    expect(splitStoryBeat(b, 0, segmentTimes)).toBeNull()
    expect(splitStoryBeat(b, 10, segmentTimes)).toBeNull()
    expect(splitStoryBeat(b, -5, segmentTimes)).toBeNull()
    expect(splitStoryBeat(b, 15, segmentTimes)).toBeNull()
  })

  it('splits into two beats at the given time, each spanning the correct sub-range', () => {
    const b = beat({ startTime: 0, endTime: 12, segmentIds: ['seg-1', 'seg-2', 'seg-3', 'seg-4'] })
    const result = splitStoryBeat(b, 6, segmentTimes)
    expect(result).not.toBeNull()
    const [first, second] = result!
    expect(first.startTime).toBe(0)
    expect(first.endTime).toBe(6)
    expect(second.startTime).toBe(6)
    expect(second.endTime).toBe(12)
  })

  it('partitions segmentIds by midpoint relative to the split time', () => {
    const b = beat({ startTime: 0, endTime: 12, segmentIds: ['seg-1', 'seg-2', 'seg-3', 'seg-4'] })
    const [first, second] = splitStoryBeat(b, 6, segmentTimes)!
    // seg-1 (mid 1.5), seg-2 (mid 4.5) < 6 -> first half; seg-3 (mid 7.5), seg-4 (mid 10.5) >= 6 -> second half.
    expect(first.segmentIds).toEqual(['seg-1', 'seg-2'])
    expect(second.segmentIds).toEqual(['seg-3', 'seg-4'])
  })

  it('produces distinct ids and "(Part 1)"/"(Part 2)" titles', () => {
    const b = beat({ id: 'beat-x', title: 'Origin', startTime: 0, endTime: 10 })
    const [first, second] = splitStoryBeat(b, 5, segmentTimes)!
    expect(first.id).toBe('beat-x-a')
    expect(second.id).toBe('beat-x-b')
    expect(first.title).toBe('Origin (Part 1)')
    expect(second.title).toBe('Origin (Part 2)')
  })

  it('copies entities/relations to both halves rather than dropping either', () => {
    const b = beat({ entities: ['e1', 'e2'], relations: ['r1'], startTime: 0, endTime: 10 })
    const [first, second] = splitStoryBeat(b, 5, segmentTimes)!
    expect(first.entities).toEqual(['e1', 'e2'])
    expect(second.entities).toEqual(['e1', 'e2'])
    expect(first.relations).toEqual(['r1'])
    expect(second.relations).toEqual(['r1'])
  })

  it('never orphans a half with zero segments when the source beat had at least two', () => {
    // All segments happen to have a midpoint before atTime -- without the
    // fallback, `second` would end up with an empty segmentIds array.
    const skewedTimes = { 'seg-1': { startTime: 0, endTime: 1 }, 'seg-2': { startTime: 1, endTime: 2 } }
    const b = beat({ startTime: 0, endTime: 10, segmentIds: ['seg-1', 'seg-2'] })
    const [first, second] = splitStoryBeat(b, 9, skewedTimes)!
    expect(first.segmentIds.length).toBeGreaterThan(0)
    expect(second.segmentIds.length).toBeGreaterThan(0)
  })

  it('falls back to the beat start time for a segment missing from the lookup, without crashing', () => {
    const b = beat({ startTime: 0, endTime: 10, segmentIds: ['seg-unknown'] })
    const result = splitStoryBeat(b, 5, {})
    expect(result).not.toBeNull()
  })
})
