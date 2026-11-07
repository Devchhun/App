import { describe, expect, it } from 'vitest'
import { buildAutoEditSequence } from './autoEditPlacement'
import type { ProjectSequence } from '@shared/project'
import type { AutoEditPlan } from '@shared/autoEdit'

const emptySequence: ProjectSequence = {
  tracks: [
    { id: 'V1', kind: 'video', name: 'Video 1', order: 0, height: 40, hidden: false, locked: false, removable: true, isMain: true },
    { id: 'A1', kind: 'audio', name: 'Narration', order: 0, height: 40, hidden: false, locked: false, removable: true },
  ],
  clips: [],
  markers: [],
  duration: 0,
}

const plan: AutoEditPlan = {
  clips: [
    { sourceScene: 0, sourceIn: 0, sourceOut: 4, timelineStart: 0, duration: 4, narrationId: 'n1' },
    { sourceScene: 1, sourceIn: 30, sourceOut: 34, timelineStart: 4, duration: 4, narrationId: 'n1' },
  ],
  duration: 8,
  usedHold: 4,
}

let counter = 0
const ids = (): string => `x${(counter += 1)}`

describe('buildAutoEditSequence', () => {
  it('adds video clips on a new track without touching existing tracks/clips', () => {
    counter = 0
    const next = buildAutoEditSequence(emptySequence, plan, { mediaId: 'src', durationSeconds: 90 }, undefined, ids)
    // Existing tracks kept, one video track appended.
    expect(next.tracks.filter((t) => t.id === 'V1')).toHaveLength(1)
    const added = next.tracks.find((t) => t.name === 'AI Edit')
    expect(added?.kind).toBe('video')
    const videoClips = next.clips.filter((c) => c.trackId === added?.id)
    expect(videoClips).toHaveLength(2)
    expect(videoClips[0].mediaId).toBe('src')
    expect(videoClips[1].sourceIn).toBe(30)
    expect(next.duration).toBe(8)
  })

  it('adds a narration audio clip on its own track when given narration', () => {
    counter = 0
    const next = buildAutoEditSequence(emptySequence, plan, { mediaId: 'src', durationSeconds: 90 }, { mediaId: 'narr', durationSeconds: 8 }, ids)
    const audio = next.tracks.find((t) => t.name === 'AI Narration')
    expect(audio?.kind).toBe('audio')
    const audioClip = next.clips.find((c) => c.trackId === audio?.id)
    expect(audioClip?.mediaId).toBe('narr')
    expect(audioClip?.duration).toBe(8)
    expect(audioClip?.type).toBe('audio')
  })

  it('never lets a clip run past the real media length', () => {
    counter = 0
    const next = buildAutoEditSequence(emptySequence, plan, { mediaId: 'src', durationSeconds: 32 }, undefined, ids)
    const clips = next.clips.filter((c) => c.mediaId === 'src')
    expect(Math.max(...clips.map((c) => c.sourceOut ?? 0))).toBeLessThanOrEqual(32)
  })
})
