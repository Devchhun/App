import { describe, expect, it } from 'vitest'
import type { TimelineClip } from '@shared/project'
import { isReframed, needsReframe, newlyAddedVideoClips } from './autoReframe'

const clip = (id: string, mediaId: string, patch: Partial<TimelineClip> = {}): TimelineClip => ({ id, mediaId, type: 'video', trackId: 'V1', startTime: 0, duration: 5, sourceIn: 0, sourceOut: 5, locked: false, ...patch })

describe('Auto Reframe by itself', () => {
  it('takes only video files new to the Timeline, on the main track', () => {
    const before = new Set(['ep1'])
    const clips = [
      clip('a', 'ep1'), // already there (a cut of it is not "added")
      clip('b', 'ep2'), // just added
      clip('c', 'ep3', { trackId: 'V2' }), // not the main track
      clip('d', 'logo', { type: 'image' }),
      clip('e', 'ep4', { locked: true }),
      clip('f', 'ep5', { keyframes: { x: [{ id: 'rf-1', time: 0, value: 10 }] } }) // already reframed
    ]
    expect(newlyAddedVideoClips(before, clips, 'V1').map((c) => c.id)).toEqual(['b'])
    expect(isReframed(clips[5])).toBe(true)
    expect(isReframed(clips[1])).toBe(false)
  })

  it('reframes only a picture of another shape than the frame', () => {
    expect(needsReframe({ width: 1920, height: 1080 }, 9 / 16)).toBe(true)
    expect(needsReframe({ width: 1080, height: 1920 }, 9 / 16)).toBe(false)
    expect(needsReframe({ width: 1080, height: 1920 }, 16 / 9)).toBe(true)
    // Size not known yet: the look decides.
    expect(needsReframe(undefined, 9 / 16)).toBe(true)
  })
})
