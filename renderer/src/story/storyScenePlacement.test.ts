import { describe, expect, it } from 'vitest'
import type { TimelineTrack } from '@shared/timelineTracks'
import type { StoryBeat } from '@shared/story'
import { planStoryBeatPlacements } from './storyScenePlacement'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 30, hidden: false, locked: false, removable: true, ...overrides }
}

function beat(overrides: Partial<StoryBeat> & Pick<StoryBeat, 'id' | 'startTime' | 'endTime'>): StoryBeat {
  return {
    segmentIds: ['seg-1'],
    title: 'Beat',
    summary: 'summary',
    purpose: 'purpose',
    entities: [],
    relations: [],
    recommendedVisualization: 'central-identity',
    importance: 'important',
    ...overrides
  }
}

const graphicTrack = track({ id: 'V2', kind: 'graphic', order: 0 })

describe('planStoryBeatPlacements', () => {
  it('routes non-overlapping beats onto the same free track', () => {
    const beats = [beat({ id: 'b1', startTime: 0, endTime: 3 }), beat({ id: 'b2', startTime: 5, endTime: 8 })]
    const placements = planStoryBeatPlacements(beats, [graphicTrack], [])
    expect(placements.map((p) => p.trackId)).toEqual(['V2', 'V2'])
  })

  it('routes overlapping beats (a deliberate continuity overlap) onto separate tracks', () => {
    const beats = [beat({ id: 'b1', startTime: 0, endTime: 5 }), beat({ id: 'b2', startTime: 4, endTime: 9 })]
    const placements = planStoryBeatPlacements(beats, [graphicTrack], [])
    expect(new Set(placements.map((p) => p.trackId)).size).toBe(2)
  })

  it('never places a beat where an existing clip/scene already occupies that track+time', () => {
    const occupied = [{ trackId: 'V2', startTime: 0, endTime: 10 }]
    const placements = planStoryBeatPlacements([beat({ id: 'b1', startTime: 2, endTime: 5 })], [graphicTrack], occupied)
    expect(placements[0].trackId).not.toBe('V2')
    expect(placements[0].newTrack).toBeDefined()
  })

  it('skips a locked track when routing', () => {
    const lockedTrack = track({ id: 'V2', kind: 'graphic', order: 0, locked: true })
    const placements = planStoryBeatPlacements([beat({ id: 'b1', startTime: 0, endTime: 3 })], [lockedTrack], [])
    expect(placements[0].trackId).not.toBe('V2')
    expect(placements[0].newTrack).toBeDefined()
  })

  it('processes beats in start-time order regardless of input order', () => {
    const beats = [beat({ id: 'late', startTime: 5, endTime: 9 }), beat({ id: 'early', startTime: 0, endTime: 6 })]
    const placements = planStoryBeatPlacements(beats, [graphicTrack], [])
    const byId = new Map(placements.map((p) => [p.beat.id, p.trackId]))
    expect(byId.get('early')).not.toBe(byId.get('late'))
  })
})
