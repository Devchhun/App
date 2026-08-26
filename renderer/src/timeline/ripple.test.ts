import { describe, expect, it } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import type { TimelineTrack } from '@shared/timelineTracks'
import { resolveRippleTrackIds, rippleInsert, rippleDelete, rippleTrim } from './ripple'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, sourceOut: 999, locked: false, ...overrides }
}

function seq(tracks: TimelineTrack[], clips: TimelineClip[]): ProjectSequence {
  return { tracks, clips, markers: [], duration: 100 }
}

const tracks = [
  track({ id: 'V1', kind: 'video', order: 0 }),
  track({ id: 'A1', kind: 'audio', order: 0 }),
  track({ id: 'A2', kind: 'audio', order: 1, locked: true })
]

describe('resolveRippleTrackIds', () => {
  it("'current' scope returns just the source track", () => {
    expect(resolveRippleTrackIds(tracks, 'V1', 'current')).toEqual(['V1'])
  })
  it("'all-unlocked' scope returns every unlocked track, excluding locked ones", () => {
    expect(resolveRippleTrackIds(tracks, 'V1', 'all-unlocked').sort()).toEqual(['A1', 'V1'])
  })
  it("'linked' scope adds the linked partner's track", () => {
    const v = clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a' })
    const a = clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' })
    expect(resolveRippleTrackIds(tracks, 'V1', 'linked', [v], [v, a]).sort()).toEqual(['A1', 'V1'])
  })
  it("'linked' scope with no linked partner is just the source track", () => {
    const v = clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5 })
    expect(resolveRippleTrackIds(tracks, 'V1', 'linked', [v], [v])).toEqual(['V1'])
  })
})

describe('rippleInsert', () => {
  it('pushes clips at/after the insertion point right by the given duration, scoped to current track only', () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'b', trackId: 'A1', startTime: 5, duration: 5 })
    ]
    const result = rippleInsert(seq(tracks, clips), 'V1', 5, 3, 'current')
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(8)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(5) // untouched -- current scope only
  })

  it("'all-unlocked' scope pushes matching-time clips on every unlocked track", () => {
    const clips = [
      clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'b', trackId: 'A1', startTime: 5, duration: 5 }),
      clip({ id: 'c', trackId: 'A2', startTime: 5, duration: 5 })
    ]
    const result = rippleInsert(seq(tracks, clips), 'V1', 5, 3, 'all-unlocked')
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(8)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(8)
    expect(result.clips.find((c) => c.id === 'c')!.startTime).toBe(5) // A2 is locked -- untouched
  })
})

describe('rippleDelete', () => {
  it('closes the gap the deleted clip leaves behind', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 })]
    const result = rippleDelete(seq(tracks, clips), ['a'], 'current')
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(0)
  })

  it('never deletes a locked clip', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, locked: true })]
    const result = rippleDelete(seq(tracks, clips), ['a'], 'current')
    expect(result.clips.find((c) => c.id === 'a')).toBeDefined()
  })

  it("'linked' scope closes the gap on the partner's track too", () => {
    const v = clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a-audio' })
    const vNext = clip({ id: 'v-next', trackId: 'V1', startTime: 5, duration: 3 })
    const a = clip({ id: 'a-audio', trackId: 'A1', startTime: 0, duration: 5, type: 'audio', linkedClipId: 'v' })
    const aNext = clip({ id: 'a-next', trackId: 'A1', startTime: 5, duration: 3, type: 'audio' })
    const result = rippleDelete(seq(tracks, [v, vNext, a, aNext]), ['v', 'a-audio'], 'linked')
    expect(result.clips.find((c) => c.id === 'v-next')!.startTime).toBe(0)
    expect(result.clips.find((c) => c.id === 'a-next')!.startTime).toBe(0)
  })
})

describe('rippleTrim', () => {
  it('shortening the right edge pulls later clips left', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }), clip({ id: 'b', trackId: 'V1', startTime: 10, duration: 5 })]
    const result = rippleTrim(seq(tracks, clips), 'a', 'right', 6, 'current', 100)
    expect(result.clips.find((c) => c.id === 'a')!.duration).toBe(6)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(6)
  })

  it('extending the right edge pushes later clips right', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V1', startTime: 5, duration: 5 })]
    const result = rippleTrim(seq(tracks, clips), 'a', 'right', 8, 'current', 100)
    expect(result.clips.find((c) => c.id === 'a')!.duration).toBe(8)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(8)
  })

  it('left-edge trim applies normally without rippling earlier clips', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 5, sourceIn: 5 }), clip({ id: 'before', trackId: 'V1', startTime: 0, duration: 5 })]
    const result = rippleTrim(seq(tracks, clips), 'a', 'left', 7, 'current', 100)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(7)
    expect(result.clips.find((c) => c.id === 'before')!.startTime).toBe(0)
  })

  it('is a no-op for a locked clip', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10, locked: true })]
    const original = seq(tracks, clips)
    expect(rippleTrim(original, 'a', 'right', 5, 'current')).toBe(original)
  })
})
