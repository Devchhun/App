import { describe, expect, it } from 'vitest'
import type { TimelineTrack } from '@shared/timelineTracks'
import {
  rangesOverlap,
  nextTrackId,
  nextTrackName,
  trackOrderForNewTrack,
  findOrCreateTrack,
  sortTracksForDisplay,
  visibleTracksForDisplay,
  withCaptionTrackContent,
  findOrCreateNarrationTrack,
  isNarrationTrackId,
  findOrCreateDubbingTrack,
  isDubbingTrackId,
  ensureDubbingTrack,
  isInViewport,
  trackDisplayHeight,
  resolveActiveVideoClip,
  getMainVideoTrackId,
  ensureTrack,
  ensureNarrationTrack,
  addTrack,
  addTrackAt,
  duplicateTrack,
  renameTrack,
  removeTrack,
  moveTrackToIndex,
  reorderTrack,
  setTrackHeight,
  toggleTrackFlag,
  collapseAll,
  isTrackAudioMuted
} from './trackModel'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

describe('rangesOverlap', () => {
  it('detects genuine overlap', () => {
    expect(rangesOverlap(0, 5, 3, 8)).toBe(true)
  })
  it('touching ranges do not overlap', () => {
    expect(rangesOverlap(0, 3, 3, 6)).toBe(false)
  })
  it('disjoint ranges do not overlap', () => {
    expect(rangesOverlap(0, 3, 10, 13)).toBe(false)
  })
})

describe('nextTrackId / nextTrackName', () => {
  it('starts at 1 for an empty kind', () => {
    expect(nextTrackId([], 'video')).toBe('V1')
    expect(nextTrackName([], 'video')).toBe('Video 1')
  })
  it('is gap-aware: V1,V3 existing -> next is V4', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V3', kind: 'video', order: 1 })]
    expect(nextTrackId(tracks, 'video')).toBe('V4')
  })
  it('ignores other kinds when numbering, for kinds with a unique prefix', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'A1', kind: 'audio', order: 0 })]
    expect(nextTrackId(tracks, 'graphic')).toBe('G1')
  })

  it('never collides with an existing id even across kinds sharing a prefix (legacy V2/V3 graphic tracks)', () => {
    // createDefaultTracks() keeps 'V2'/'V3' as the (kind: 'graphic') Overlay/
    // Graphics tracks' ids for backward compatibility -- a freshly-created
    // kind:'video' track must never compute 'V2' too, or it would silently
    // collide with the real V2 track (see the ensureTrack ambiguity this
    // caused: the ready-made track never gets added and clips vanish).
    const tracks = [
      track({ id: 'V1', kind: 'video', order: 0 }),
      track({ id: 'V2', kind: 'graphic', order: 0 }),
      track({ id: 'V3', kind: 'graphic', order: 1 })
    ]
    expect(nextTrackId(tracks, 'video')).toBe('V4')
  })
})

describe('trackOrderForNewTrack', () => {
  it('is 0 for the first track of a kind', () => {
    expect(trackOrderForNewTrack([], 'graphic')).toBe(0)
  })
  it('stacks above existing same-kind tracks (video/graphic/text)', () => {
    const tracks = [track({ id: 'G1', kind: 'graphic', order: 0 }), track({ id: 'G2', kind: 'graphic', order: 1 })]
    expect(trackOrderForNewTrack(tracks, 'graphic')).toBe(2)
  })
  it('appends for audio', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', order: 0 })]
    expect(trackOrderForNewTrack(tracks, 'audio')).toBe(1)
  })
})

describe('findOrCreateTrack', () => {
  it('reuses an existing free same-kind track', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1 })]
    const occupied = [{ trackId: 'V1', startTime: 0, endTime: 5 }]
    const result = findOrCreateTrack(tracks, occupied, 0, 3, 'video')
    expect(result).toEqual({ trackId: 'V2' })
  })
  it('synthesizes a new track when every same-kind track is occupied', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 })]
    const occupied = [{ trackId: 'V1', startTime: 0, endTime: 5 }]
    const result = findOrCreateTrack(tracks, occupied, 0, 3, 'video')
    expect(result.trackId).toBe('V2')
    expect(result.newTrack).toMatchObject({ id: 'V2', kind: 'video', order: 1 })
  })
  it('returns the first free track when the desired window is clear', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 })]
    const result = findOrCreateTrack(tracks, [], 10, 3, 'video')
    expect(result).toEqual({ trackId: 'V1' })
  })
  it('skips locked tracks even if they are free at that time', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, locked: true }), track({ id: 'V2', kind: 'video', order: 1 })]
    const result = findOrCreateTrack(tracks, [], 0, 3, 'video')
    expect(result).toEqual({ trackId: 'V2' })
  })
  it('synthesizes a video track that does not collide with the legacy V2/V3 graphic tracks', () => {
    const tracks = [
      track({ id: 'V1', kind: 'video', order: 0 }),
      track({ id: 'V2', kind: 'graphic', order: 0 }),
      track({ id: 'V3', kind: 'graphic', order: 1 }),
      track({ id: 'A1', kind: 'audio', order: 0 }),
      track({ id: 'A2', kind: 'audio', order: 1 }),
      track({ id: 'C1', kind: 'caption', order: 0, removable: false })
    ]
    const occupied = [{ trackId: 'V1', startTime: 0, endTime: 10 }]
    const result = findOrCreateTrack(tracks, occupied, 0, 5, 'video')
    expect(result.newTrack?.id).toBe('V4')
    expect(result.newTrack?.kind).toBe('video')
  })

  it('three same-time graphics create three graphic tracks', () => {
    let tracks: TimelineTrack[] = []
    const occupied: { trackId: string; startTime: number; endTime: number }[] = []
    const created: string[] = []
    for (let i = 0; i < 3; i++) {
      const result = findOrCreateTrack(tracks, occupied, 5, 3, 'graphic')
      if (result.newTrack) tracks = [...tracks, result.newTrack]
      occupied.push({ trackId: result.trackId, startTime: 5, endTime: 8 })
      created.push(result.trackId)
    }
    expect(created).toEqual(['G1', 'G2', 'G3'])
  })

  it('never routes an audio insertion onto an empty VO-prefixed track (regression: a regular video import\'s own auto-linked audio landed on VO1, mixing it into the Story Narration track)', () => {
    const tracks = [track({ id: 'VO1', kind: 'audio', order: 0, removable: false })]
    const result = findOrCreateTrack(tracks, [], 0, 5, 'audio')
    expect(result.trackId).not.toMatch(/^VO/)
    expect(result.trackId).toBe('A1')
  })
})

describe('findOrCreateNarrationTrack', () => {
  it('creates VO1 from scratch when no VO track exists yet', () => {
    const result = findOrCreateNarrationTrack([], [], 5, 3)
    expect(result.trackId).toBe('VO1')
    expect(result.newTrack).toMatchObject({ id: 'VO1', kind: 'audio', removable: true })
  })

  it('reuses VO1 when it is free at the desired time', () => {
    const tracks = [track({ id: 'VO1', kind: 'audio', order: 0, removable: false })]
    const result = findOrCreateNarrationTrack(tracks, [], 5, 3)
    expect(result).toEqual({ trackId: 'VO1' })
  })

  it('routes to VO2 when VO1 is occupied at the desired time, creating it if needed', () => {
    const tracks = [track({ id: 'VO1', kind: 'audio', order: 0, removable: false })]
    const occupied = [{ trackId: 'VO1', startTime: 0, endTime: 8 }]
    const result = findOrCreateNarrationTrack(tracks, occupied, 5, 3)
    expect(result.trackId).toBe('VO2')
    expect(result.newTrack).toMatchObject({ id: 'VO2', kind: 'audio', name: 'VO2 · Voice Over', removable: true })
  })

  it('reuses an existing free VO2 rather than creating VO3', () => {
    const tracks = [track({ id: 'VO1', kind: 'audio', order: 0, removable: false }), track({ id: 'VO2', kind: 'audio', order: 1, removable: true })]
    const occupied = [{ trackId: 'VO1', startTime: 0, endTime: 8 }]
    const result = findOrCreateNarrationTrack(tracks, occupied, 5, 3)
    expect(result).toEqual({ trackId: 'VO2' })
  })

  it('never routes onto a plain, generically-numbered audio track (A1/A2), only VO-prefixed ones', () => {
    const tracks = [track({ id: 'VO1', kind: 'audio', order: 0, removable: false }), track({ id: 'A1', kind: 'audio', order: 1 })]
    const occupied = [{ trackId: 'VO1', startTime: 0, endTime: 8 }]
    const result = findOrCreateNarrationTrack(tracks, occupied, 5, 3)
    expect(result.trackId).toBe('VO2')
  })

  it('skips a locked VO track even if it is free at that time', () => {
    const tracks = [track({ id: 'VO1', kind: 'audio', order: 0, removable: false, locked: true })]
    const result = findOrCreateNarrationTrack(tracks, [], 5, 3)
    expect(result.trackId).toBe('VO2')
  })
})

describe('isNarrationTrackId', () => {
  it('is true for VO1 and any overflow VO-numbered track (regression: a take that overflowed onto VO2+ rendered as a plain unstyled clip, not the violet "Take N" style, because this used to be a literal `=== \'VO1\'` check)', () => {
    expect(isNarrationTrackId('VO1')).toBe(true)
    expect(isNarrationTrackId('VO2')).toBe(true)
    expect(isNarrationTrackId('VO17')).toBe(true)
  })

  it('is false for generic audio tracks and anything else', () => {
    expect(isNarrationTrackId('A1')).toBe(false)
    expect(isNarrationTrackId('V1')).toBe(false)
    expect(isNarrationTrackId('C1')).toBe(false)
    expect(isNarrationTrackId('VOX')).toBe(false)
  })
})

describe('findOrCreateDubbingTrack', () => {
  it('creates DUB1 from scratch when no DUB track exists yet', () => {
    const result = findOrCreateDubbingTrack([], [], 5, 3)
    expect(result.trackId).toBe('DUB1')
    expect(result.newTrack).toMatchObject({ id: 'DUB1', kind: 'audio', removable: true })
  })

  it('reuses DUB1 when it is free at the desired time', () => {
    const tracks = [track({ id: 'DUB1', kind: 'audio', order: 0, removable: false })]
    const result = findOrCreateDubbingTrack(tracks, [], 5, 3)
    expect(result).toEqual({ trackId: 'DUB1' })
  })

  it('routes to DUB2 when DUB1 is occupied at the desired time, creating it if needed', () => {
    const tracks = [track({ id: 'DUB1', kind: 'audio', order: 0, removable: false })]
    const occupied = [{ trackId: 'DUB1', startTime: 0, endTime: 8 }]
    const result = findOrCreateDubbingTrack(tracks, occupied, 5, 3)
    expect(result.trackId).toBe('DUB2')
    expect(result.newTrack).toMatchObject({ id: 'DUB2', kind: 'audio', name: 'DUB2 · AI Dubbing', removable: true })
  })

  it('reuses an existing free DUB2 rather than creating DUB3', () => {
    const tracks = [track({ id: 'DUB1', kind: 'audio', order: 0, removable: false }), track({ id: 'DUB2', kind: 'audio', order: 1, removable: true })]
    const occupied = [{ trackId: 'DUB1', startTime: 0, endTime: 8 }]
    const result = findOrCreateDubbingTrack(tracks, occupied, 5, 3)
    expect(result).toEqual({ trackId: 'DUB2' })
  })

  it('never routes onto a plain, generically-numbered audio track (A1/A2) or a VO narration track, only DUB-prefixed ones', () => {
    const tracks = [
      track({ id: 'DUB1', kind: 'audio', order: 0, removable: false }),
      track({ id: 'A1', kind: 'audio', order: 1 }),
      track({ id: 'VO1', kind: 'audio', order: 2, removable: false })
    ]
    const occupied = [{ trackId: 'DUB1', startTime: 0, endTime: 8 }]
    const result = findOrCreateDubbingTrack(tracks, occupied, 5, 3)
    expect(result.trackId).toBe('DUB2')
  })

  it('skips a locked DUB track even if it is free at that time', () => {
    const tracks = [track({ id: 'DUB1', kind: 'audio', order: 0, removable: false, locked: true })]
    const result = findOrCreateDubbingTrack(tracks, [], 5, 3)
    expect(result.trackId).toBe('DUB2')
  })
})

describe('isDubbingTrackId', () => {
  it('is true for DUB1 and any overflow DUB-numbered track', () => {
    expect(isDubbingTrackId('DUB1')).toBe(true)
    expect(isDubbingTrackId('DUB2')).toBe(true)
    expect(isDubbingTrackId('DUB17')).toBe(true)
  })

  it('is false for generic audio tracks, VO narration tracks, and anything else', () => {
    expect(isDubbingTrackId('A1')).toBe(false)
    expect(isDubbingTrackId('V1')).toBe(false)
    expect(isDubbingTrackId('VO1')).toBe(false)
    expect(isDubbingTrackId('DUBX')).toBe(false)
  })
})

describe('findOrCreateTrack excludes DUB tracks (regression guard alongside the existing VO exclusion)', () => {
  it('never routes generic audio insertion onto an empty DUB1', () => {
    const tracks = [track({ id: 'DUB1', kind: 'audio', order: 0, removable: false }), track({ id: 'A1', kind: 'audio', order: 1 })]
    const result = findOrCreateTrack(tracks, [], 5, 3, 'audio')
    expect(result.trackId).toBe('A1')
  })
})

describe('ensureDubbingTrack (AI Dubber)', () => {
  it('adds a DUB1 audio track, not removable, when missing', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 })]
    const result = ensureDubbingTrack(tracks)
    const dub1 = result.find((t) => t.id === 'DUB1')
    expect(dub1).toBeDefined()
    expect(dub1!.kind).toBe('audio')
    expect(dub1!.removable).toBe(false)
  })

  it('is idempotent -- calling it again when DUB1 already exists changes nothing', () => {
    const tracks = ensureDubbingTrack([track({ id: 'V1', kind: 'video', order: 0, isMain: true })])
    expect(ensureDubbingTrack(tracks)).toBe(tracks)
  })

  it('never touches or removes any other track', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 }), track({ id: 'A2', kind: 'audio', order: 1 })]
    const result = ensureDubbingTrack(tracks)
    expect(result.map((t) => t.id)).toEqual(['V1', 'A1', 'A2', 'DUB1'])
  })
})

describe('sortTracksForDisplay', () => {
  it('orders video/graphic/text highest-order-first, audio ascending, caption last', () => {
    const tracks = [
      track({ id: 'A2', kind: 'audio', order: 1 }),
      track({ id: 'C1', kind: 'caption', order: 0 }),
      track({ id: 'V1', kind: 'video', order: 0 }),
      track({ id: 'A1', kind: 'audio', order: 0 }),
      track({ id: 'V2', kind: 'video', order: 1 })
    ]
    expect(sortTracksForDisplay(tracks).map((t) => t.id)).toEqual(['V2', 'V1', 'A1', 'A2', 'C1'])
  })

  it('keeps every visual overlay above Main Track and only audio/SRT below it', () => {
    const tracks = [
      track({ id: 'A1', kind: 'audio', order: 0 }),
      track({ id: 'V1', kind: 'video', order: 9, isMain: true }),
      track({ id: 'T1', kind: 'text', order: 0 }),
      track({ id: 'C1', kind: 'caption', order: 0 }),
      track({ id: 'G1', kind: 'graphic', order: 0 }),
      track({ id: 'V2', kind: 'video', order: 0 })
    ]
    expect(sortTracksForDisplay(tracks).map((t) => t.id)).toEqual(['T1', 'G1', 'V2', 'V1', 'A1', 'C1'])
  })
})

describe('visibleTracksForDisplay', () => {
  it('hides every empty non-main track (Overlay/Graphics/Music, and the caption track before anything is captioned) but keeps the main video track', () => {
    const tracks = [
      track({ id: 'V1', kind: 'video', order: 0, isMain: true }),
      track({ id: 'V2', kind: 'graphic', order: 0 }),
      track({ id: 'A1', kind: 'audio', order: 0 }),
      track({ id: 'C1', kind: 'caption', order: 0, removable: false })
    ]
    const result = visibleTracksForDisplay(tracks, { V1: true })
    expect(result.map((t) => t.id)).toEqual(['V1'])
  })

  it('shows any track with real content, regardless of kind or isMain', () => {
    const tracks = [
      track({ id: 'V1', kind: 'video', order: 0, isMain: true }),
      track({ id: 'V4', kind: 'video', order: 1 }),
      track({ id: 'A2', kind: 'audio', order: 1 })
    ]
    const result = visibleTracksForDisplay(tracks, { V1: true, A2: true })
    expect(result.map((t) => t.id)).toEqual(['V1', 'A2'])
  })

  it('a single-clip project stays compact: only the tracks holding real content render', () => {
    const tracks = [
      track({ id: 'V1', kind: 'video', order: 0, isMain: true }),
      track({ id: 'V2', kind: 'graphic', order: 0 }),
      track({ id: 'V3', kind: 'graphic', order: 1 }),
      track({ id: 'A1', kind: 'audio', order: 0 }),
      track({ id: 'A2', kind: 'audio', order: 1 }),
      track({ id: 'C1', kind: 'caption', order: 0, removable: false })
    ]
    const result = visibleTracksForDisplay(tracks, { V1: true, A1: true })
    expect(result.map((t) => t.id)).toEqual(['V1', 'A1'])
  })

  it('shows the caption track once it actually has content', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'C1', kind: 'caption', order: 0, removable: false })]
    const result = visibleTracksForDisplay(tracks, { V1: true, C1: true })
    expect(result.map((t) => t.id)).toEqual(['V1', 'C1'])
  })

  it('never removes tracks from the underlying array -- purely a display-layer filter', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'V2', kind: 'graphic', order: 0 })]
    visibleTracksForDisplay(tracks, {})
    expect(tracks.map((t) => t.id)).toEqual(['V1', 'V2'])
  })

  it('shows an alwaysVisibleIds track (e.g. VO1) even when empty and not main -- Story Narration Workspace', () => {
    const tracks = [
      track({ id: 'V1', kind: 'video', order: 0, isMain: true }),
      track({ id: 'VO1', kind: 'audio', order: 1, removable: false }),
      track({ id: 'A2', kind: 'audio', order: 2 })
    ]
    const result = visibleTracksForDisplay(tracks, { V1: true }, new Set(['VO1']))
    expect(result.map((t) => t.id)).toEqual(['V1', 'VO1'])
  })

  it('alwaysVisibleIds is optional -- omitting it behaves exactly as before', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 })]
    const result = visibleTracksForDisplay(tracks, { V1: true })
    expect(result.map((t) => t.id)).toEqual(['V1'])
  })
})

describe('withCaptionTrackContent', () => {
  it('marks the caption track has-content once real segments exist (regression: C1 was permanently invisible before this)', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'C1', kind: 'caption', order: 0, removable: false })]
    const map = withCaptionTrackContent({ V1: true }, tracks, true)
    expect(map).toEqual({ V1: true, C1: true })
    expect(visibleTracksForDisplay(tracks, map).map((t) => t.id)).toEqual(['V1', 'C1'])
  })

  it('leaves the map untouched when there are no segments', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'C1', kind: 'caption', order: 0, removable: false })]
    const map = withCaptionTrackContent({ V1: true }, tracks, false)
    expect(map).toEqual({ V1: true })
  })

  it('never mutates the input map (returns a new object when marking content)', () => {
    const tracks = [track({ id: 'C1', kind: 'caption', order: 0, removable: false })]
    const input = { V1: true }
    const result = withCaptionTrackContent(input, tracks, true)
    expect(input).toEqual({ V1: true })
    expect(result).not.toBe(input)
  })
})

describe('isInViewport', () => {
  it('is true for a clip fully inside the visible window', () => {
    expect(isInViewport(10, 5, 0, 100)).toBe(true)
  })

  it('is true for a clip that only partially overlaps the visible window', () => {
    expect(isInViewport(95, 10, 0, 100)).toBe(true) // starts before the end, ends after it
    expect(isInViewport(-5, 10, 0, 100)).toBe(true) // starts before the start, ends after it
  })

  it('is false for a clip entirely before or after the visible window', () => {
    expect(isInViewport(-20, 10, 0, 100)).toBe(false)
    expect(isInViewport(110, 10, 0, 100)).toBe(false)
  })

  it('a clip exactly touching the viewport edge does not count as visible (half-open interval)', () => {
    expect(isInViewport(100, 10, 0, 100)).toBe(false)
    expect(isInViewport(-10, 10, 0, 100)).toBe(false)
  })
})

describe('trackDisplayHeight', () => {
  it('returns the track height normally', () => {
    expect(trackDisplayHeight(track({ id: 'V1', kind: 'video', order: 0, height: 52 }))).toBe(52)
  })
  it('collapses to the minimum when collapsed', () => {
    expect(trackDisplayHeight(track({ id: 'V1', kind: 'video', order: 0, height: 52, collapsed: true }))).toBe(28)
  })
  it('defaults to normal mode (unscaled) when no mode is given -- old callers are unaffected', () => {
    expect(trackDisplayHeight(track({ id: 'V1', kind: 'video', order: 0, height: 40 }))).toBe(40)
  })
  it('compact mode scales down, tall mode scales up', () => {
    const t = track({ id: 'V1', kind: 'video', order: 0, height: 40 })
    expect(trackDisplayHeight(t, 'compact')).toBeLessThan(40)
    expect(trackDisplayHeight(t, 'tall')).toBeGreaterThan(40)
  })
  it('never scales below the minimum track height even in compact mode', () => {
    const t = track({ id: 'V1', kind: 'video', order: 0, height: 28 })
    expect(trackDisplayHeight(t, 'compact')).toBeGreaterThanOrEqual(28)
  })
  it('a collapsed track ignores height mode -- always the minimum', () => {
    const t = track({ id: 'V1', kind: 'video', order: 0, height: 52, collapsed: true })
    expect(trackDisplayHeight(t, 'tall')).toBe(28)
  })
})

describe('resolveActiveVideoClip', () => {
  const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1 })]
  it('picks the highest-order video track active at time', () => {
    const clips = [
      { id: 'a', trackId: 'V1', startTime: 0, duration: 10 },
      { id: 'b', trackId: 'V2', startTime: 0, duration: 10 }
    ]
    expect(resolveActiveVideoClip(clips, tracks, 5)?.id).toBe('b')
  })
  it('falls back to whichever video track has an active clip', () => {
    const clips = [{ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }]
    expect(resolveActiveVideoClip(clips, tracks, 5)?.id).toBe('a')
  })
  it('returns undefined when no video clip is active', () => {
    const clips = [{ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }]
    expect(resolveActiveVideoClip(clips, tracks, 5)).toBeUndefined()
  })
  it('ignores clips on non-video-kind tracks', () => {
    const nonVideoTracks = [track({ id: 'A1', kind: 'audio', order: 0 })]
    const clips = [{ id: 'a', trackId: 'A1', startTime: 0, duration: 10 }]
    expect(resolveActiveVideoClip(clips, nonVideoTracks, 5)).toBeUndefined()
  })
})

describe('getMainVideoTrackId', () => {
  it('finds the track with isMain set', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1, isMain: true })]
    expect(getMainVideoTrackId(tracks)).toBe('V2')
  })
  it('returns undefined when no track is main', () => {
    expect(getMainVideoTrackId([track({ id: 'V1', kind: 'video', order: 0 })])).toBeUndefined()
  })
})

describe('ensureTrack', () => {
  it('appends a track that is not already present', () => {
    const newTrack = track({ id: 'G2', kind: 'graphic', order: 1 })
    const result = ensureTrack([track({ id: 'G1', kind: 'graphic', order: 0 })], newTrack)
    expect(result.map((t) => t.id)).toEqual(['G1', 'G2'])
  })
  it('is idempotent when the track id already exists', () => {
    const tracks = [track({ id: 'G1', kind: 'graphic', order: 0 })]
    expect(ensureTrack(tracks, track({ id: 'G1', kind: 'graphic', order: 0 }))).toEqual(tracks)
  })
})

describe('ensureNarrationTrack (Story Narration Workspace)', () => {
  it('adds a VO1 audio track, not removable, when missing', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 })]
    const result = ensureNarrationTrack(tracks)
    const vo1 = result.find((t) => t.id === 'VO1')
    expect(vo1).toBeDefined()
    expect(vo1!.kind).toBe('audio')
    expect(vo1!.removable).toBe(false)
    // Labeled distinctly from A1 (already labeled "Narration" for the video's own audio).
    expect(vo1!.name).not.toBe('Narration')
  })

  it('is idempotent -- calling it again when VO1 already exists changes nothing', () => {
    const tracks = ensureNarrationTrack([track({ id: 'V1', kind: 'video', order: 0, isMain: true })])
    expect(ensureNarrationTrack(tracks)).toBe(tracks)
  })

  it('never touches or removes any other track', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 }), track({ id: 'A2', kind: 'audio', order: 1 })]
    const result = ensureNarrationTrack(tracks)
    expect(result.map((t) => t.id)).toEqual(['V1', 'A1', 'A2', 'VO1'])
  })
})

describe('addTrackAt', () => {
  it('places the new track directly above the reference track in display order', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1 })]
    // Display order today (highest order first): V2, V1. "Above V1" means
    // between V2 and V1, i.e. display index 1.
    const result = addTrackAt(tracks, 'video', 'V1', 'above')
    const displayIds = sortTracksForDisplay(result).map((t) => t.id)
    expect(displayIds.indexOf('V3')).toBe(displayIds.indexOf('V1') - 1)
  })

  it('places the new track directly below the reference track in display order', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1 })]
    const result = addTrackAt(tracks, 'video', 'V1', 'below')
    const displayIds = sortTracksForDisplay(result).map((t) => t.id)
    expect(displayIds.indexOf('V3')).toBe(displayIds.indexOf('V1') + 1)
  })
})

describe('track CRUD', () => {
  it('addTrack appends a new track of the given kind', () => {
    const result = addTrack([], 'audio')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'A1', kind: 'audio', muted: false })
  })

  it('duplicateTrack copies an existing track under a new id', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, name: 'Video 1' })]
    const result = duplicateTrack(tracks, 'V1')
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ id: 'V2', kind: 'video' })
  })

  it('duplicateTrack never copies isMain onto the copy', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true })]
    const result = duplicateTrack(tracks, 'V1')
    expect(result[0].isMain).toBe(true)
    expect(result[1].isMain).toBe(false)
  })

  it('renameTrack updates the name, ignoring blank input', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 })]
    expect(renameTrack(tracks, 'V1', 'B-Roll')[0].name).toBe('B-Roll')
    expect(renameTrack(tracks, 'V1', '   ')[0].name).toBe('V1')
  })

  it('removeTrack deletes a removable track', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 })]
    expect(removeTrack(tracks, 'V1')).toHaveLength(0)
  })

  it('removeTrack rejects a non-removable track', () => {
    const tracks = [track({ id: 'C1', kind: 'caption', order: 0, removable: false })]
    expect(removeTrack(tracks, 'C1')).toEqual(tracks)
  })

  it('removeTrack promotes the next video track to isMain when the main track is deleted', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'V4', kind: 'video', order: 1 })]
    const result = removeTrack(tracks, 'V1')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'V4', isMain: true })
  })

  it('removeTrack leaves no main track when the last video track is deleted', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, isMain: true })]
    expect(getMainVideoTrackId(removeTrack(tracks, 'V1'))).toBeUndefined()
  })

  it('reorderTrack moving up increases visual stacking order for video', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1 })]
    // V1 is displayed below V2 (order 0 < 1); moving V1 "up" should make it topmost.
    const result = reorderTrack(tracks, 'V1', 'up')
    const v1 = result.find((t) => t.id === 'V1')!
    const v2 = result.find((t) => t.id === 'V2')!
    expect(v1.order).toBeGreaterThan(v2.order)
  })

  it('reorderTrack is a no-op at the boundary', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1 })]
    // V2 is already topmost (index 0 in display order) -- moving further up is a no-op.
    const result = reorderTrack(tracks, 'V2', 'up')
    expect(result).toEqual(tracks)
  })

  it('setTrackHeight clamps to [28,160]', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 })]
    expect(setTrackHeight(tracks, 'V1', 5)[0].height).toBe(28)
    expect(setTrackHeight(tracks, 'V1', 999)[0].height).toBe(160)
    expect(setTrackHeight(tracks, 'V1', 60)[0].height).toBe(60)
  })

  it('toggleTrackFlag flips the given boolean flag', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0, hidden: false })]
    expect(toggleTrackFlag(tracks, 'V1', 'hidden')[0].hidden).toBe(true)
  })

  it('collapseAll sets every track collapsed flag', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'A1', kind: 'audio', order: 0 })]
    expect(collapseAll(tracks, true).every((t) => t.collapsed)).toBe(true)
    expect(collapseAll(tracks, false).every((t) => !t.collapsed)).toBe(true)
  })
})

describe('isTrackAudioMuted', () => {
  it('is false by default (no mute, no solo anywhere)', () => {
    const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'A1', kind: 'audio', order: 0 })]
    expect(isTrackAudioMuted(tracks, 'V1')).toBe(false)
    expect(isTrackAudioMuted(tracks, 'A1')).toBe(false)
  })

  it('is true for a track with muted:true', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', order: 0, muted: true })]
    expect(isTrackAudioMuted(tracks, 'A1')).toBe(true)
  })

  it('once ANY track is soloed, every non-soloed track is muted regardless of its own muted flag', () => {
    const tracks = [
      track({ id: 'A1', kind: 'audio', order: 0, solo: true }),
      track({ id: 'A2', kind: 'audio', order: 1 }),
      track({ id: 'A3', kind: 'audio', order: 2, muted: false })
    ]
    expect(isTrackAudioMuted(tracks, 'A1')).toBe(false) // the soloed track itself stays audible
    expect(isTrackAudioMuted(tracks, 'A2')).toBe(true)
    expect(isTrackAudioMuted(tracks, 'A3')).toBe(true)
  })

  it('soloing a track makes it audible even if it is also explicitly muted (solo wins for the soloed track itself)', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', order: 0, solo: true, muted: true })]
    expect(isTrackAudioMuted(tracks, 'A1')).toBe(false)
  })

  it('returns false for an unknown track id rather than throwing', () => {
    expect(isTrackAudioMuted([], 'missing')).toBe(false)
  })
})
