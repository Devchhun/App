import { describe, expect, it } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import type { TimelineTrack } from '@shared/timelineTracks'
import { moveClipMagnetic, insertClipMagnetic, nearestInsertionBoundary } from './magnet'

let idCounter = 0
function makeId(): string {
  idCounter += 1
  return `id-${idCounter}`
}

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, sourceOut: overrides.duration, locked: false, ...overrides }
}

function seq(tracks: TimelineTrack[], clips: TimelineClip[]): ProjectSequence {
  return { tracks, clips, markers: [], duration: 100 }
}

const mainTrack = [track({ id: 'V1', kind: 'video', order: 0, isMain: true })]

describe('nearestInsertionBoundary', () => {
  it('returns 0 for an empty track', () => {
    expect(nearestInsertionBoundary([], 'V1', 50)).toBe(0)
  })
  it('snaps to whichever boundary (clip start/end) is closest', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 })]
    expect(nearestInsertionBoundary(clips, 'V1', 8)).toBe(10)
    expect(nearestInsertionBoundary(clips, 'V1', 2)).toBe(0)
  })
})

describe('moveClipMagnetic -- reordering a gapless track', () => {
  it('reorders [A][B][C] -> [A][C][B] when C is dragged between A and B', () => {
    const clips = [
      clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'B', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'C', trackId: 'V1', startTime: 10, duration: 5 })
    ]
    const result = moveClipMagnetic(seq(mainTrack, clips), 'C', 6) // dropped near the A/B boundary
    const ordered = result.clips.slice().sort((a, b) => a.startTime - b.startTime).map((c) => c.id)
    expect(ordered).toEqual(['A', 'C', 'B'])
  })

  it('stays perfectly gapless after reordering (each clip starts exactly where the previous ends)', () => {
    const clips = [
      clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 4 }),
      clip({ id: 'B', trackId: 'V1', startTime: 4, duration: 6 }),
      clip({ id: 'C', trackId: 'V1', startTime: 10, duration: 3 })
    ]
    const result = moveClipMagnetic(seq(mainTrack, clips), 'A', 20) // drag A to the very end
    const ordered = result.clips.slice().sort((a, b) => a.startTime - b.startTime)
    expect(ordered.map((c) => c.id)).toEqual(['B', 'C', 'A'])
    expect(ordered[0].startTime).toBe(0)
    expect(ordered[1].startTime).toBe(ordered[0].startTime + ordered[0].duration)
    expect(ordered[2].startTime).toBe(ordered[1].startTime + ordered[1].duration)
  })

  it('moving a clip away closes the gap it left behind', () => {
    const clips = [
      clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'B', trackId: 'V1', startTime: 5, duration: 5 })
    ]
    const result = moveClipMagnetic(seq(mainTrack, clips), 'A', 20)
    // A moved to the end; B should have shifted left to close A's old gap.
    const b = result.clips.find((c) => c.id === 'B')!
    expect(b.startTime).toBe(0)
  })

  it('cascades a linked audio partner by the same delta', () => {
    const clips = [
      clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'A-audio' }),
      clip({ id: 'B', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'A-audio', trackId: 'A1', startTime: 0, duration: 5, type: 'audio', linkedClipId: 'A' })
    ]
    const result = moveClipMagnetic(seq(mainTrack, clips), 'A', 20)
    const a = result.clips.find((c) => c.id === 'A')!
    const aAudio = result.clips.find((c) => c.id === 'A-audio')!
    expect(aAudio.startTime).toBe(a.startTime)
  })

  it('is a no-op for a locked clip', () => {
    const clips = [
      clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5, locked: true }),
      clip({ id: 'B', trackId: 'V1', startTime: 5, duration: 5 })
    ]
    const original = seq(mainTrack, clips)
    expect(moveClipMagnetic(original, 'A', 20)).toBe(original)
  })

  it('leaves the linked partner in place when linked=false (Linkage toggle off)', () => {
    const clips = [
      clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'A-audio' }),
      clip({ id: 'B', trackId: 'V1', startTime: 5, duration: 5 }),
      clip({ id: 'A-audio', trackId: 'A1', startTime: 0, duration: 5, type: 'audio', linkedClipId: 'A' })
    ]
    const result = moveClipMagnetic(seq(mainTrack, clips), 'A', 20, false)
    expect(result.clips.find((c) => c.id === 'A-audio')!.startTime).toBe(0)
  })

  it('is a no-op when it is the only clip on the track', () => {
    const clips = [clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5 })]
    const original = seq(mainTrack, clips)
    expect(moveClipMagnetic(original, 'A', 20)).toBe(original)
  })
})

describe('insertClipMagnetic -- inserting into a gapless track', () => {
  it('inserts at the nearest boundary and pushes everything after it right, staying gapless', () => {
    const clips = [clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'B', trackId: 'V1', startTime: 5, duration: 5 })]
    const result = insertClipMagnetic(seq(mainTrack, clips), { mediaId: 'new', type: 'video', sourceDurationSeconds: 4 }, 4, makeId)
    const ordered = result.clips.filter((c) => c.trackId === 'V1').sort((a, b) => a.startTime - b.startTime)
    expect(ordered.map((c) => c.mediaId)).toEqual(['m1', 'new', 'm1'])
    expect(ordered[0].startTime).toBe(0)
    expect(ordered[1].startTime).toBe(5)
    expect(ordered[2].startTime).toBe(9)
  })

  it('appends to the end when the nearest boundary is the track end', () => {
    const clips = [clip({ id: 'A', trackId: 'V1', startTime: 0, duration: 5 })]
    const result = insertClipMagnetic(seq(mainTrack, clips), { mediaId: 'new', type: 'video', sourceDurationSeconds: 3 }, 100, makeId)
    const newClip = result.clips.find((c) => c.mediaId === 'new')!
    expect(newClip.startTime).toBe(5)
  })

  it('returns the sequence unchanged when there is no main track', () => {
    const noMain = [track({ id: 'V1', kind: 'video', order: 0 })]
    const original = seq(noMain, [])
    expect(insertClipMagnetic(original, { mediaId: 'new', type: 'video', sourceDurationSeconds: 3 }, 0, makeId)).toBe(original)
  })
})
