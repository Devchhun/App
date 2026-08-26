import { describe, expect, it } from 'vitest'
import type { TimelineTrack } from '@shared/timelineTracks'
import { planSequentialDrop, planStackDrop, type DropAsset } from './placementPlanning'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

const videoTrack = track({ id: 'V1', kind: 'video', order: 0 })
const video = (mediaId: string, dur = 10): DropAsset => ({ mediaId, type: 'video', sourceDurationSeconds: dur })
const image = (mediaId: string): DropAsset => ({ mediaId, type: 'image', sourceDurationSeconds: 0 })

describe('planSequentialDrop', () => {
  it('places assets back-to-back, each on the free existing track', () => {
    const placements = planSequentialDrop([video('m1', 10), image('m2')], 0, [videoTrack], [])
    expect(placements.map((p) => ({ trackId: p.trackId, startTime: p.startTime, duration: p.duration }))).toEqual([
      { trackId: 'V1', startTime: 0, duration: 10 },
      { trackId: 'V1', startTime: 10, duration: 5 }
    ])
  })

  it('routes video and audio assets onto different kind tracks while staying time-sequential', () => {
    const audioTrack = track({ id: 'A1', kind: 'audio', order: 0 })
    const placements = planSequentialDrop([video('m1', 10), { mediaId: 'm2', type: 'audio', sourceDurationSeconds: 5 }], 0, [videoTrack, audioTrack], [])
    expect(placements[0]).toMatchObject({ trackId: 'V1', startTime: 0, duration: 10 })
    expect(placements[1]).toMatchObject({ trackId: 'A1', startTime: 10, duration: 5 })
  })

  it('starts from the given dropTime, not always 0', () => {
    const placements = planSequentialDrop([video('m1', 4)], 20, [videoTrack], [])
    expect(placements[0].startTime).toBe(20)
  })
})

describe('planStackDrop', () => {
  it('places every asset at the same start time on separate tracks, creating new ones as needed', () => {
    const placements = planStackDrop([video('m1'), image('m2'), image('m3')], 5, [videoTrack], [])
    expect(placements.every((p) => p.startTime === 5)).toBe(true)
    const trackIds = placements.map((p) => p.trackId)
    expect(new Set(trackIds).size).toBe(3)
    expect(trackIds).toEqual(['V1', 'V2', 'V3'])
    expect(placements[1].newTrack).toMatchObject({ id: 'V2', kind: 'video' })
    expect(placements[2].newTrack).toMatchObject({ id: 'V3', kind: 'video' })
  })

  it('reuses an existing free track before creating a new one', () => {
    const secondVideoTrack = track({ id: 'V2', kind: 'video', order: 1 })
    const placements = planStackDrop([video('m1'), video('m2')], 0, [videoTrack, secondVideoTrack], [])
    expect(placements.map((p) => p.trackId)).toEqual(['V1', 'V2'])
    expect(placements.every((p) => !p.newTrack)).toBe(true)
  })
})
