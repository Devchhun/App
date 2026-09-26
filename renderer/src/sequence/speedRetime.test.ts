import { describe, expect, it } from 'vitest'
import { applyClipProperties } from './sequenceOps'
import type { ProjectSequence, TimelineClip } from '@shared/project'

const clip = (over: Partial<TimelineClip>): TimelineClip => ({
  id: 'c1',
  mediaId: 'm1',
  trackId: 'A1',
  type: 'audio',
  startTime: 0,
  duration: 10,
  sourceIn: 0,
  sourceOut: 10,
  locked: false,
  ...over
})

const sequence = (clips: TimelineClip[]): ProjectSequence => ({
  clips,
  tracks: [
    { id: 'V1', kind: 'video', name: 'V1', order: 0, removable: false, isMain: true, height: 56, hidden: false, locked: false },
    { id: 'A1', kind: 'audio', name: 'A1', order: 1, removable: true, height: 48, hidden: false, locked: false }
  ],
  markers: [],
  duration: 10
})

describe('speed on audio clips', () => {
  it('halves a plain audio clip when set to 2x', () => {
    const next = applyClipProperties(sequence([clip({})]), ['c1'], { playbackRate: 2 })
    expect(next.clips[0].playbackRate).toBe(2)
    expect(next.clips[0].duration).toBeCloseTo(5)
  })

  it('stretches it when slowed down', () => {
    const next = applyClipProperties(sequence([clip({})]), ['c1'], { playbackRate: 0.5 })
    expect(next.clips[0].duration).toBeCloseTo(20)
  })

  it('works on a generated clip that has no sourceOut recorded', () => {
    const next = applyClipProperties(sequence([clip({ sourceOut: undefined })]), ['c1'], { playbackRate: 2 })
    expect(next.clips[0].duration).toBeCloseTo(5)
  })

  it('retimes a linked video+audio pair by the same amount, from either side', () => {
    const video = clip({ id: 'v', trackId: 'V1', type: 'video', linkedClipId: 'a' })
    const audio = clip({ id: 'a', trackId: 'A1', type: 'audio', linkedClipId: 'v' })
    const fromVideo = applyClipProperties(sequence([video, audio]), ['v'], { playbackRate: 2 })
    expect(fromVideo.clips.map((c) => [c.id, c.playbackRate, Math.round(c.duration)])).toEqual([
      ['v', 2, 5],
      ['a', 2, 5]
    ])
    const fromAudio = applyClipProperties(sequence([video, audio]), ['a'], { playbackRate: 0.5 })
    expect(fromAudio.clips.map((c) => [c.id, c.playbackRate, Math.round(c.duration)])).toEqual([
      ['v', 0.5, 20],
      ['a', 0.5, 20]
    ])
  })
})
