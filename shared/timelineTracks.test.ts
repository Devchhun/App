import { describe, it, expect } from 'vitest'
import { createDefaultTracks, pruneEmptyTracks, usedTrackIds } from './timelineTracks'
import type { TimelineTrack } from './timelineTracks'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind'>): TimelineTrack {
  return { name: overrides.id, order: 0, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

describe('usedTrackIds', () => {
  it('collects every trackId referenced by a clip or a scene', () => {
    const ids = usedTrackIds([{ trackId: 'V1' }, { trackId: 'A1' }], [{ track: 'V2' }])
    expect(ids).toEqual(new Set(['V1', 'A1', 'V2']))
  })

  it('returns an empty set for no clips and no scenes', () => {
    expect(usedTrackIds([], [])).toEqual(new Set())
  })
})

describe('pruneEmptyTracks', () => {
  it('keeps the main video track and the fixed caption track even when empty', () => {
    const tracks = createDefaultTracks()
    const result = pruneEmptyTracks(tracks, new Set())
    expect(result.map((t) => t.id)).toEqual(['V1', 'C1'])
  })

  it('drops every other empty track: default Overlay/Graphics/Music, plus debris left behind by a past bug', () => {
    const tracks: TimelineTrack[] = [
      ...createDefaultTracks(),
      track({ id: 'V4', kind: 'video' }),
      track({ id: 'V5', kind: 'video' }),
      track({ id: 'V6', kind: 'video' })
    ]
    const result = pruneEmptyTracks(tracks, new Set(['A1']))
    expect(result.map((t) => t.id)).toEqual(['V1', 'A1', 'C1'])
  })

  it('keeps any track that actually has a clip or scene on it, regardless of kind', () => {
    const tracks: TimelineTrack[] = [...createDefaultTracks(), track({ id: 'V4', kind: 'video' })]
    const result = pruneEmptyTracks(tracks, new Set(['V2', 'V4']))
    expect(result.map((t) => t.id).sort()).toEqual(['C1', 'V1', 'V2', 'V4'])
  })

  it('is idempotent -- pruning an already-pruned list changes nothing', () => {
    const tracks = createDefaultTracks()
    const once = pruneEmptyTracks(tracks, new Set(['A1']))
    const twice = pruneEmptyTracks(once, new Set(['A1']))
    expect(twice).toEqual(once)
  })
})
