import { describe, expect, it } from 'vitest'
import type { TimelineTrack } from '@shared/timelineTracks'
import type { ScenePlanScene } from '@shared/localAi'
import { planScenePlacements } from './scenePlacementPlanning'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 30, hidden: false, locked: false, removable: true, ...overrides }
}

function scene(overrides: Partial<ScenePlanScene> & Pick<ScenePlanScene, 'id' | 'startTime' | 'endTime'>): ScenePlanScene {
  return {
    segmentId: 'seg-1',
    purpose: 'introduction',
    templateId: 'lower-third',
    content: {},
    confidence: 0.9,
    explanation: 'because',
    ...overrides
  }
}

const graphicTrack = track({ id: 'V2', kind: 'graphic', order: 0 })

describe('planScenePlacements', () => {
  it('routes non-overlapping scenes onto the same free track', () => {
    const scenes = [scene({ id: 's1', startTime: 0, endTime: 3 }), scene({ id: 's2', startTime: 5, endTime: 8 })]
    const placements = planScenePlacements(scenes, [graphicTrack], [])
    expect(placements.map((p) => p.trackId)).toEqual(['V2', 'V2'])
    expect(placements.every((p) => !p.newTrack)).toBe(true)
  })

  it('routes two time-overlapping scenes onto separate graphics tracks (never overwrite/overlap)', () => {
    const scenes = [scene({ id: 's1', startTime: 0, endTime: 5 }), scene({ id: 's2', startTime: 2, endTime: 6 })]
    const placements = planScenePlacements(scenes, [graphicTrack], [])
    const trackIds = placements.map((p) => p.trackId)
    expect(new Set(trackIds).size).toBe(2)
    expect(trackIds[0]).toBe('V2')
    expect(placements[1].newTrack).toMatchObject({ kind: 'graphic' })
  })

  it('routes three mutually-overlapping scenes onto three separate tracks', () => {
    const scenes = [
      scene({ id: 's1', startTime: 0, endTime: 10 }),
      scene({ id: 's2', startTime: 1, endTime: 9 }),
      scene({ id: 's3', startTime: 2, endTime: 8 })
    ]
    const placements = planScenePlacements(scenes, [graphicTrack], [])
    expect(new Set(placements.map((p) => p.trackId)).size).toBe(3)
  })

  it('never places a scene where an existing clip/scene already occupies that track+time (never overwrites existing content)', () => {
    const occupied = [{ trackId: 'V2', startTime: 0, endTime: 10 }]
    const scenes = [scene({ id: 's1', startTime: 2, endTime: 5 })]
    const placements = planScenePlacements(scenes, [graphicTrack], occupied)
    expect(placements[0].trackId).not.toBe('V2')
    expect(placements[0].newTrack).toBeDefined()
  })

  it('skips a locked track when routing', () => {
    const lockedTrack = track({ id: 'V2', kind: 'graphic', order: 0, locked: true })
    const scenes = [scene({ id: 's1', startTime: 0, endTime: 3 })]
    const placements = planScenePlacements(scenes, [lockedTrack], [])
    expect(placements[0].trackId).not.toBe('V2')
    expect(placements[0].newTrack).toBeDefined()
  })

  it('processes scenes in start-time order regardless of input order (so overlap detection is order-independent)', () => {
    const scenes = [scene({ id: 'late', startTime: 5, endTime: 9 }), scene({ id: 'early', startTime: 0, endTime: 6 })]
    const placements = planScenePlacements(scenes, [graphicTrack], [])
    // "early" (0-6) and "late" (5-9) overlap [5,6) regardless of array order -- must still land on separate tracks.
    const byId = new Map(placements.map((p) => [p.scene.id, p.trackId]))
    expect(byId.get('early')).not.toBe(byId.get('late'))
  })

  it('reuses a free existing track before creating a new one', () => {
    const secondGraphicTrack = track({ id: 'V3', kind: 'graphic', order: 1 })
    const scenes = [scene({ id: 's1', startTime: 0, endTime: 5 }), scene({ id: 's2', startTime: 1, endTime: 4 })]
    const placements = planScenePlacements(scenes, [graphicTrack, secondGraphicTrack], [])
    expect(new Set(placements.map((p) => p.trackId))).toEqual(new Set(['V2', 'V3']))
    expect(placements.every((p) => !p.newTrack)).toBe(true)
  })
})
