import { describe, expect, it } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeOverwritePreview, applyOverwrite } from './overwriteDrop'

let idCounter = 0
function makeId(): string {
  idCounter += 1
  return `new-${idCounter}`
}

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, sourceOut: 999, locked: false, ...overrides }
}

function seq(clips: TimelineClip[]): ProjectSequence {
  return { tracks: [], clips, markers: [], duration: 100 }
}

describe('computeOverwritePreview', () => {
  it('returns null when nothing overlaps', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })])
    expect(computeOverwritePreview(s, 'V1', 10, 3)).toBeNull()
  })

  it('classifies a fully-contained clip as removed', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 2 })])
    const preview = computeOverwritePreview(s, 'V1', 0, 10)!
    expect(preview.removedClipIds).toEqual(['a'])
    expect(preview.trimmedClipIds).toEqual([])
  })

  it('classifies a partially-overlapping clip as trimmed', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })])
    const preview = computeOverwritePreview(s, 'V1', 3, 5)!
    expect(preview.trimmedClipIds).toEqual(['a'])
    expect(preview.removedClipIds).toEqual([])
  })

  it('ignores locked clips', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, locked: true })])
    expect(computeOverwritePreview(s, 'V1', 0, 5)).toBeNull()
  })

  it('ignores other tracks', () => {
    const s = seq([clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5 })])
    expect(computeOverwritePreview(s, 'V1', 0, 5)).toBeNull()
  })
})

describe('applyOverwrite', () => {
  it('removes a fully-contained clip and inserts the new one', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 2 })])
    const result = applyOverwrite(s, { mediaId: 'new', type: 'video', trackId: 'V1', startTime: 0, duration: 10, sourceIn: 0, locked: false }, makeId)
    expect(result.clips.find((c) => c.id === 'a')).toBeUndefined()
    expect(result.clips.some((c) => c.mediaId === 'new')).toBe(true)
  })

  it('trims a clip extending in from the left', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })])
    const result = applyOverwrite(s, { mediaId: 'new', type: 'video', trackId: 'V1', startTime: 3, duration: 5, sourceIn: 0, locked: false }, makeId)
    const a = result.clips.find((c) => c.id === 'a')!
    expect(a.startTime).toBe(0)
    expect(a.duration).toBe(3)
  })

  it('trims a clip extending out past the right', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 3, duration: 5 })])
    const result = applyOverwrite(s, { mediaId: 'new', type: 'video', trackId: 'V1', startTime: 0, duration: 5, sourceIn: 0, locked: false }, makeId)
    const a = result.clips.find((c) => c.id === 'a')!
    expect(a.startTime).toBe(5)
  })

  it('splits a clip that fully contains the overwritten range into two remainders', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 20 })])
    const result = applyOverwrite(s, { mediaId: 'new', type: 'video', trackId: 'V1', startTime: 5, duration: 5, sourceIn: 0, locked: false }, makeId)
    const remainders = result.clips.filter((c) => c.mediaId === 'm1')
    expect(remainders).toHaveLength(2)
    const left = remainders.find((c) => c.startTime === 0)!
    const right = remainders.find((c) => c.startTime === 10)!
    expect(left.duration).toBe(5)
    expect(right.startTime + right.duration).toBe(20)
  })

  it('never touches a locked clip', () => {
    const s = seq([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, locked: true })])
    const result = applyOverwrite(s, { mediaId: 'new', type: 'video', trackId: 'V1', startTime: 0, duration: 5, sourceIn: 0, locked: false }, makeId)
    expect(result.clips.find((c) => c.id === 'a')).toBeDefined()
  })
})
