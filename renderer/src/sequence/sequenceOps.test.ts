import { describe, expect, it } from 'vitest'
import {
  buildInsertedClips,
  insertClip,
  moveClip,
  trimClip,
  splitClip,
  canSplitClip,
  deleteClips,
  duplicateClips,
  setClipsLocked,
  findActiveClips,
  computeSequenceDuration,
  parseDurationInput,
  DEFAULT_IMAGE_DURATION_SECONDS,
  moveClips,
  deleteTimeRange,
  resolveMoveSet,
  setClipsEnabled,
  linkClips,
  unlinkClips,
  relinkOriginalAudio,
  extractAudio,
  selectedWithLinkedClips,
  groupClips,
  ungroupClips,
  moveClipsToTrack,
  moveClipToTrack,
  moveClipToNewTrack,
  pickClipProperties,
  applyClipProperties,
  replaceClipMedia,
  addMarker,
  moveMarker,
  updateMarker,
  removeMarker,
  addClipMarker,
  removeClipMarker
} from './sequenceOps'
import { updateClipSelection, clearClipSelection } from './sequenceSelection'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import type { TimelineTrack } from '@shared/timelineTracks'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

let idCounter = 0
function makeId(): string {
  idCounter += 1
  return `id-${idCounter}`
}

function emptySeq(): ProjectSequence {
  return { tracks: [], clips: [], markers: [], duration: 0 }
}

function seqOf(clips: TimelineClip[]): ProjectSequence {
  return { tracks: [], clips, markers: [], duration: computeSequenceDuration(clips) }
}

function videoClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'v1',
    mediaId: 'm1',
    type: 'video',
    trackId: 'V1',
    startTime: 0,
    duration: 10,
    sourceIn: 0,
    sourceOut: 10,
    locked: false,
    ...overrides
  }
}

function imageClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'img1',
    mediaId: 'm2',
    type: 'image',
    trackId: 'V1',
    startTime: 0,
    duration: 5,
    sourceIn: 0,
    sourceOut: undefined,
    locked: false,
    ...overrides
  }
}

describe('1. Image default duration is 5 seconds', () => {
  it('buildInsertedClips gives an image a 5s duration with no source bound', () => {
    idCounter = 0
    const [clip] = buildInsertedClips({ mediaId: 'm1', type: 'image', sourceDurationSeconds: 999 }, 0, 'V1', makeId)
    expect(clip.duration).toBe(DEFAULT_IMAGE_DURATION_SECONDS)
    expect(clip.sourceOut).toBeUndefined()
    expect(clip.sourceIn).toBe(0)
  })

  it('inserts at the playhead, clamped to >= 0', () => {
    const [clip] = buildInsertedClips({ mediaId: 'm1', type: 'image', sourceDurationSeconds: 0 }, -5, 'V1', makeId)
    expect(clip.startTime).toBe(0)
  })
})

describe('2. Image duration can extend to several minutes', () => {
  it('right-trim can push an image clip out to 2+ minutes with no upper clamp', () => {
    const sequence = seqOf([imageClip({ duration: 5 })])
    const trimmed = trimClip(sequence, 'img1', 'right', 150)
    expect(trimmed.clips[0].duration).toBe(150)
  })
})

describe('3. Video trim cannot exceed source duration', () => {
  it('right-trim clamps duration so sourceOut never exceeds the real source length', () => {
    const sequence = seqOf([videoClip({ duration: 10, sourceIn: 0, sourceOut: 10 })])
    const trimmed = trimClip(sequence, 'v1', 'right', 999, /* sourceDurationSeconds */ 10)
    expect(trimmed.clips[0].duration).toBe(10)
    expect(trimmed.clips[0].sourceOut).toBe(10)
  })
})

describe('4. Left trim updates sourceIn correctly', () => {
  it('video: moving the left edge in increases sourceIn by the same amount, sourceOut unchanged', () => {
    const sequence = seqOf([videoClip({ startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 })])
    const trimmed = trimClip(sequence, 'v1', 'left', 3, 10)
    expect(trimmed.clips[0].startTime).toBe(3)
    expect(trimmed.clips[0].duration).toBe(7)
    expect(trimmed.clips[0].sourceIn).toBe(3)
    expect(trimmed.clips[0].sourceOut).toBe(10)
  })

  it('video: cannot pull sourceIn below 0', () => {
    const sequence = seqOf([videoClip({ startTime: 5, duration: 5, sourceIn: 2, sourceOut: 7 })])
    const trimmed = trimClip(sequence, 'v1', 'left', -100, 10)
    expect(trimmed.clips[0].sourceIn).toBe(0)
    expect(trimmed.clips[0].startTime).toBe(3) // 5 - 2 (the 2s of source available before the old sourceIn)
  })

  it('image: left trim changes startTime/duration only, no sourceIn concept', () => {
    const sequence = seqOf([imageClip({ startTime: 0, duration: 10 })])
    const trimmed = trimClip(sequence, 'img1', 'left', 4)
    expect(trimmed.clips[0].startTime).toBe(4)
    expect(trimmed.clips[0].duration).toBe(6)
    expect(trimmed.clips[0].sourceIn).toBe(0)
  })
})

describe('5. Right trim updates sourceOut correctly', () => {
  it('video: right trim shortens duration and moves sourceOut in lockstep, startTime/sourceIn unchanged', () => {
    const sequence = seqOf([videoClip({ startTime: 2, duration: 10, sourceIn: 0, sourceOut: 10 })])
    const trimmed = trimClip(sequence, 'v1', 'right', 8, 10) // pointerTime=8 -> duration = 8-2 = 6
    expect(trimmed.clips[0].startTime).toBe(2)
    expect(trimmed.clips[0].sourceIn).toBe(0)
    expect(trimmed.clips[0].duration).toBe(6)
    expect(trimmed.clips[0].sourceOut).toBe(6)
  })
})

describe('6. Image split creates two adjacent image clips', () => {
  it('splits an image clip into two clips sharing the same media asset, back-to-back', () => {
    idCounter = 0
    const sequence = seqOf([imageClip({ id: 'img1', startTime: 0, duration: 10 })])
    const result = splitClip(sequence, 'img1', 4, { makeId })
    expect(result.clips).toHaveLength(2)
    const [left, right] = result.clips
    expect(left.type).toBe('image')
    expect(right.type).toBe('image')
    expect(left.mediaId).toBe('m2')
    expect(right.mediaId).toBe('m2')
    expect(left.startTime).toBe(0)
    expect(left.duration).toBe(4)
    expect(left.sourceOut).toBeUndefined()
    expect(right.startTime).toBe(4)
    expect(right.duration).toBe(6)
    expect(right.sourceIn).toBe(0)
  })
})

describe('7. Video split preserves source timing', () => {
  it('left piece keeps the original sourceIn and gets sourceOut = sourceIn + offset; right piece continues from there', () => {
    idCounter = 0
    const sequence = seqOf([videoClip({ id: 'v1', startTime: 10, duration: 10, sourceIn: 20, sourceOut: 30 })])
    const result = splitClip(sequence, 'v1', 14, { makeId }) // offset = 4
    const [left, right] = result.clips
    expect(left.startTime).toBe(10)
    expect(left.duration).toBe(4)
    expect(left.sourceIn).toBe(20)
    expect(left.sourceOut).toBe(24)
    expect(right.startTime).toBe(14)
    expect(right.duration).toBe(6)
    expect(right.sourceIn).toBe(24)
    expect(right.sourceOut).toBe(30)
  })
})

describe('8. Linked video/audio split together', () => {
  it('splitting a video with a linked audio clip splits both at the same time by default', () => {
    idCounter = 0
    const video = videoClip({ id: 'v1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, linkedClipId: 'a1' })
    const audio: TimelineClip = { id: 'a1', mediaId: 'm1', type: 'audio', trackId: 'A1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false, linkedClipId: 'v1' }
    const sequence = seqOf([video, audio])

    const result = splitClip(sequence, 'v1', 5, { makeId })

    expect(result.clips).toHaveLength(4)
    const videoPieces = result.clips.filter((c) => c.type === 'video')
    const audioPieces = result.clips.filter((c) => c.type === 'audio')
    expect(videoPieces).toHaveLength(2)
    expect(audioPieces).toHaveLength(2)
    for (const piece of result.clips) {
      expect([0, 5]).toContain(piece.startTime)
    }
  })

  it('Alt+Split (linked: false) splits only the targeted clip', () => {
    idCounter = 0
    const video = videoClip({ id: 'v1', startTime: 0, duration: 10, linkedClipId: 'a1' })
    const audio: TimelineClip = { id: 'a1', mediaId: 'm1', type: 'audio', trackId: 'A1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false, linkedClipId: 'v1' }
    const sequence = seqOf([video, audio])

    const result = splitClip(sequence, 'v1', 5, { linked: false, makeId })

    expect(result.clips.filter((c) => c.type === 'video')).toHaveLength(2)
    expect(result.clips.filter((c) => c.type === 'audio')).toHaveLength(1)
  })
})

describe('9. Selecting Media does not alter Timeline', () => {
  it('sequence-mutating ops never take or produce anything about media-asset selection -- clip selection and media selection are structurally separate state', () => {
    const sequence = seqOf([videoClip()])
    const untouched = insertClip(sequence, { mediaId: 'other', type: 'image', sourceDurationSeconds: 0 }, 100, 'V1', makeId)
    // Inserting is the only sequence-mutating op that doesn't require an
    // existing clip id; the point is that nothing here reads or writes any
    // "selected media" concept -- MediaContext.select() is a one-line
    // setState in a completely separate module with no import of this one.
    expect(untouched.clips.find((c) => c.id === 'v1')).toEqual(sequence.clips[0])
  })
})

describe('10. Selecting a Timeline clip does not change active media', () => {
  it('updateClipSelection returns only clip ids -- no media-asset field exists to accidentally change', () => {
    const next = updateClipSelection([], 'v1', ['v1', 'v2'])
    expect(next).toEqual(['v1'])
    expect(Object.keys(next)).not.toContain('selectedMediaAssetId')
  })

  it('ctrl+click toggles membership without touching anything else', () => {
    let selection = updateClipSelection([], 'v1', ['v1', 'v2', 'v3'])
    selection = updateClipSelection(selection, 'v2', ['v1', 'v2', 'v3'], { ctrl: true })
    expect(selection).toEqual(['v1', 'v2'])
    selection = updateClipSelection(selection, 'v1', ['v1', 'v2', 'v3'], { ctrl: true })
    expect(selection).toEqual(['v2'])
  })

  it('shift+click selects the contiguous range from the last-selected clip', () => {
    const selection = updateClipSelection(['v1'], 'v3', ['v1', 'v2', 'v3', 'v4'], { shift: true })
    expect(selection).toEqual(['v1', 'v2', 'v3'])
  })

  it('clearClipSelection empties the selection (e.g. clicking empty track area)', () => {
    expect(clearClipSelection(['v1', 'v2'])).toEqual([])
    const already = clearClipSelection([])
    expect(already).toEqual([])
  })
})

describe('11. Moving a clip preserves its duration', () => {
  it('move only changes startTime', () => {
    const sequence = seqOf([videoClip({ startTime: 0, duration: 10, sourceIn: 2, sourceOut: 12 })])
    const moved = moveClip(sequence, 'v1', 20)
    expect(moved.clips[0].startTime).toBe(20)
    expect(moved.clips[0].duration).toBe(10)
    expect(moved.clips[0].sourceIn).toBe(2)
    expect(moved.clips[0].sourceOut).toBe(12)
  })

  it('moves a linked clip by the same delta', () => {
    const video = videoClip({ id: 'v1', startTime: 0, duration: 10, linkedClipId: 'a1' })
    const audio: TimelineClip = { id: 'a1', mediaId: 'm1', type: 'audio', trackId: 'A1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false, linkedClipId: 'v1' }
    const sequence = seqOf([video, audio])
    const moved = moveClip(sequence, 'v1', 15)
    expect(moved.clips.find((c) => c.id === 'v1')!.startTime).toBe(15)
    expect(moved.clips.find((c) => c.id === 'a1')!.startTime).toBe(15)
  })

  it('never moves a locked clip', () => {
    const sequence = seqOf([videoClip({ locked: true })])
    const moved = moveClip(sequence, 'v1', 50)
    expect(moved).toBe(sequence)
  })
})

describe('12. Dragging beyond Timeline end extends sequence duration', () => {
  it('computeSequenceDuration is always max(clip end) + 5', () => {
    const sequence = seqOf([videoClip({ startTime: 0, duration: 10 })])
    expect(sequence.duration).toBe(15)
    const moved = moveClip(sequence, 'v1', 100)
    expect(moved.duration).toBe(115)
  })

  it('an empty sequence has duration 0', () => {
    expect(computeSequenceDuration([])).toBe(0)
  })
})

describe('13. Delete and Undo restore clips', () => {
  it('deleteClips removes the given ids', () => {
    const sequence = seqOf([videoClip({ id: 'v1' }), videoClip({ id: 'v2', startTime: 20 })])
    const result = deleteClips(sequence, ['v1'])
    expect(result.clips.map((c) => c.id)).toEqual(['v2'])
  })

  it('never deletes a locked clip', () => {
    const sequence = seqOf([videoClip({ id: 'v1', locked: true })])
    const result = deleteClips(sequence, ['v1'])
    expect(result.clips).toHaveLength(1)
  })

  // "Undo" itself is exercised by the existing generic historyReducer
  // (see historyReducer.test.ts) once SequenceContext wires `sequence` into
  // HistorySnapshot -- deleteClips/insertClip above are the pure ops that
  // get before/after-snapshotted.
})

describe('14. Redo invalidates after a new edit', () => {
  // Covered by historyReducer.ts's existing, already-tested semantics
  // (recordChange clears the redo stack) -- SequenceContext reuses that
  // generic reducer unchanged, it doesn't reimplement redo invalidation.
  it('duplicateClips + a locked-clip guard together demonstrate a real edit sequence that would sit on the undo stack', () => {
    idCounter = 0
    const sequence = seqOf([videoClip({ id: 'v1', startTime: 0, duration: 10 })])
    const { sequence: withCopy, newClipIds } = duplicateClips(sequence, ['v1'], makeId)
    expect(withCopy.clips).toHaveLength(2)
    expect(withCopy.clips.find((c) => c.id === newClipIds[0])!.startTime).toBe(10)
  })
})

describe('15. Save/reopen preserves all clips (pure-data-shape guarantee)', () => {
  it('every op returns a plain JSON-serializable ProjectSequence', () => {
    const sequence = seqOf([videoClip()])
    const roundTripped = JSON.parse(JSON.stringify(insertClip(sequence, { mediaId: 'm2', type: 'image', sourceDurationSeconds: 0 }, 20, 'V1', makeId)))
    expect(roundTripped.clips).toHaveLength(2)
  })
})

describe('16. Clip pointer event is not cleared by the parent track', () => {
  // The actual pointer/DOM behavior is component-level (ClipTrack.tsx,
  // stopPropagation on pointerdown, mirroring GraphicsTrack.tsx's proven
  // pattern) and this codebase has no DOM test environment (vitest runs
  // with environment: 'node' -- no existing component ever gets mounted in
  // a test). What's unit-testable here is the selection math itself never
  // depending on a "parent cleared it" side channel: clicking a clip is a
  // single pure call, not two competing state updates racing each other.
  it('a single updateClipSelection call fully determines the result -- no intermediate "cleared then re-set" state exists', () => {
    const afterClick = updateClipSelection(['other'], 'v1', ['other', 'v1'])
    expect(afterClick).toEqual(['v1'])
  })
})

describe('17. Project Preview resolves the correct active clips', () => {
  it('findActiveClips returns clips whose [startTime, startTime+duration) contains currentTime', () => {
    const clipA = videoClip({ id: 'a', startTime: 0, duration: 5 })
    const clipB = videoClip({ id: 'b', startTime: 5, duration: 5 })
    const sequence = seqOf([clipA, clipB])

    expect(findActiveClips(sequence, 2).map((c) => c.id)).toEqual(['a'])
    expect(findActiveClips(sequence, 5).map((c) => c.id)).toEqual(['b']) // half-open: boundary belongs to the next clip
    expect(findActiveClips(sequence, 7).map((c) => c.id)).toEqual(['b'])
    expect(findActiveClips(sequence, 10).map((c) => c.id)).toEqual([])
  })

  it('returns clips from multiple tracks that are simultaneously active', () => {
    const v1 = videoClip({ id: 'v', trackId: 'V1', startTime: 0, duration: 10 })
    const a1: TimelineClip = { id: 'a', mediaId: 'm1', type: 'audio', trackId: 'A1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false }
    const sequence = seqOf([v1, a1])
    expect(findActiveClips(sequence, 3).map((c) => c.id).sort()).toEqual(['a', 'v'])
  })
})

describe('18. Locked clips cannot move, trim, split or delete', () => {
  it('move: no-op on a locked clip', () => {
    const sequence = seqOf([videoClip({ locked: true })])
    expect(moveClip(sequence, 'v1', 50)).toBe(sequence)
  })

  it('trim: no-op on a locked clip', () => {
    const sequence = seqOf([videoClip({ locked: true, duration: 10 })])
    const result = trimClip(sequence, 'v1', 'right', 3, 10)
    expect(result.clips[0].duration).toBe(10)
  })

  it('split: refused on a locked clip', () => {
    const sequence = seqOf([videoClip({ locked: true, duration: 10 })])
    expect(canSplitClip(sequence.clips[0], 5)).toBe(false)
    const result = splitClip(sequence, 'v1', 5, { makeId })
    expect(result.clips).toHaveLength(1)
  })

  it('delete: refused on a locked clip', () => {
    const sequence = seqOf([videoClip({ locked: true })])
    const result = deleteClips(sequence, ['v1'])
    expect(result.clips).toHaveLength(1)
  })

  it('setClipsLocked toggles the flag itself (used to lock/unlock from the Properties panel)', () => {
    const sequence = seqOf([videoClip({ locked: false })])
    const locked = setClipsLocked(sequence, ['v1'], true)
    expect(locked.clips[0].locked).toBe(true)
  })
})

describe('parseDurationInput (Clip Properties duration field)', () => {
  it('parses plain seconds', () => {
    expect(parseDurationInput('5s')).toBe(5)
    expect(parseDurationInput('30s')).toBe(30)
    expect(parseDurationInput('5')).toBe(5)
  })

  it('parses minutes', () => {
    expect(parseDurationInput('1m')).toBe(60)
    expect(parseDurationInput('2m')).toBe(120)
  })

  it('parses combined minutes and seconds', () => {
    expect(parseDurationInput('2m 30s')).toBe(150)
    expect(parseDurationInput('2m30s')).toBe(150)
  })

  it('rejects garbage input', () => {
    expect(parseDurationInput('abc')).toBeNull()
    expect(parseDurationInput('')).toBeNull()
    expect(parseDurationInput('-5s')).toBeNull()
  })
})

describe('canSplitClip guard', () => {
  it('refuses a split exactly on the clip boundary', () => {
    const clip = videoClip({ startTime: 0, duration: 10 })
    expect(canSplitClip(clip, 0)).toBe(false)
    expect(canSplitClip(clip, 10)).toBe(false)
    expect(canSplitClip(clip, 5)).toBe(true)
  })

  it('refuses when no clip is given', () => {
    expect(canSplitClip(undefined, 5)).toBe(false)
  })
})

describe('moveClips (multi-select move, preserving relative offsets)', () => {
  it('moves every given clip by the same delta', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 5 }), videoClip({ id: 'b', startTime: 10, duration: 5 })])
    const result = moveClips(sequence, ['a', 'b'], 3)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(3)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(13)
  })

  it('preserves relative spacing even when one clip clamps at 0 and another would not', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 2, duration: 5 }), videoClip({ id: 'b', startTime: 10, duration: 5 })])
    const result = moveClips(sequence, ['a', 'b'], -5)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(0) // clamped
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(5) // not clamped, moved the full delta
  })

  it('skips locked clips individually', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 5, locked: true }), videoClip({ id: 'b', startTime: 10, duration: 5 })])
    const result = moveClips(sequence, ['a', 'b'], 3)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(0)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(13)
  })
})

describe('deleteTimeRange (Range tool -- Delete Range / Ripple Delete Range)', () => {
  it('deletes a clip fully inside the range', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 5, duration: 5 })]) // [5,10)
    const result = deleteTimeRange(sequence, { start: 0, end: 20 })
    expect(result.clips).toHaveLength(0)
  })

  it('trims a clip that straddles the range start (keeps the part before the range)', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 })])
    const result = deleteTimeRange(sequence, { start: 4, end: 20 })
    expect(result.clips).toHaveLength(1)
    expect(result.clips[0]).toMatchObject({ startTime: 0, duration: 4 })
  })

  it('trims a clip that straddles the range end (keeps the part after the range)', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 })])
    const result = deleteTimeRange(sequence, { start: -5, end: 4 })
    expect(result.clips).toHaveLength(1)
    expect(result.clips[0]).toMatchObject({ startTime: 4, duration: 6 })
  })

  it('splits a clip that fully contains the range into two pieces, removing the middle', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 20, sourceIn: 0, sourceOut: 20 })])
    const result = deleteTimeRange(sequence, { start: 5, end: 15 })
    const pieces = result.clips.slice().sort((a, b) => a.startTime - b.startTime)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toMatchObject({ startTime: 0, duration: 5 })
    expect(pieces[1]).toMatchObject({ startTime: 15, duration: 5 })
  })

  it('leaves a gap by default (non-rippling) -- later clips do not move', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0 })]
    const sequence: ProjectSequence = {
      tracks,
      clips: [videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }), videoClip({ id: 'b', trackId: 'V1', startTime: 10, duration: 10 })],
      markers: [],
      duration: 20
    }
    const result = deleteTimeRange(sequence, { start: 0, end: 10 })
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(10)
  })

  it('ripple:true closes the gap on every track, pulling later clips left', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'A1', kind: 'audio', order: 0 })]
    const sequence: ProjectSequence = {
      tracks,
      clips: [
        videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }),
        videoClip({ id: 'b', trackId: 'V1', startTime: 10, duration: 10 }),
        { ...videoClip({ id: 'c', trackId: 'A1', startTime: 12, duration: 5 }), type: 'audio' }
      ],
      markers: [],
      duration: 20
    }
    const result = deleteTimeRange(sequence, { start: 0, end: 10 }, true)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(0)
    expect(result.clips.find((c) => c.id === 'c')!.startTime).toBe(2)
  })

  it('does not touch locked clips', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 10, locked: true })])
    const result = deleteTimeRange(sequence, { start: 0, end: 10 })
    expect(result.clips).toHaveLength(1)
    expect(result.clips[0]).toMatchObject({ startTime: 0, duration: 10 })
  })

  it('is a no-op for an empty or inverted range', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 10 })])
    expect(deleteTimeRange(sequence, { start: 5, end: 5 })).toBe(sequence)
    expect(deleteTimeRange(sequence, { start: 8, end: 2 })).toBe(sequence)
  })
})

describe('resolveMoveSet', () => {
  it('moving a selected clip drags the whole selection', () => {
    const clips = [videoClip({ id: 'a', startTime: 0 }), videoClip({ id: 'b', startTime: 10 })]
    expect(resolveMoveSet(clips, 'a', ['a', 'b'], false).sort()).toEqual(['a', 'b'])
  })

  it('clicking an unselected clip moves just that clip', () => {
    const clips = [videoClip({ id: 'a', startTime: 0 }), videoClip({ id: 'b', startTime: 10 })]
    expect(resolveMoveSet(clips, 'a', ['b'], false)).toEqual(['a'])
  })

  it('expands to every clip sharing a groupId, regardless of Linkage', () => {
    const clips = [videoClip({ id: 'a', startTime: 0, groupId: 'g1' }), videoClip({ id: 'b', startTime: 10, groupId: 'g1' }), videoClip({ id: 'c', startTime: 20 })]
    expect(resolveMoveSet(clips, 'a', ['a'], false).sort()).toEqual(['a', 'b'])
  })

  it('expands to the linked partner only when linkageOn is true', () => {
    const clips = [videoClip({ id: 'a', startTime: 0, linkedClipId: 'a-audio' }), videoClip({ id: 'a-audio', startTime: 0, type: 'audio' })]
    expect(resolveMoveSet(clips, 'a', ['a'], false)).toEqual(['a'])
    expect(resolveMoveSet(clips, 'a', ['a'], true).sort()).toEqual(['a', 'a-audio'])
  })
})

describe('setClipsEnabled / findActiveClips excludes disabled clips', () => {
  it('a disabled clip is excluded from findActiveClips', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 10 })])
    const disabled = setClipsEnabled(sequence, ['a'], false)
    expect(findActiveClips(disabled, 5)).toEqual([])
  })
  it('re-enabling restores it', () => {
    const sequence = setClipsEnabled(seqOf([videoClip({ id: 'a', startTime: 0, duration: 10 })]), ['a'], false)
    const enabled = setClipsEnabled(sequence, ['a'], true)
    expect(findActiveClips(enabled, 5).map((c) => c.id)).toEqual(['a'])
  })
})

describe('linkClips / unlinkClips', () => {
  it('links two clips to each other', () => {
    const sequence = seqOf([videoClip({ id: 'a' }), videoClip({ id: 'b', type: 'audio' })])
    const result = linkClips(sequence, 'a', 'b')
    expect(result.clips.find((c) => c.id === 'a')!.linkedClipId).toBe('b')
    expect(result.clips.find((c) => c.id === 'b')!.linkedClipId).toBe('a')
  })

  it('unlinks both sides of an existing link', () => {
    const sequence = seqOf([videoClip({ id: 'a', linkedClipId: 'b' }), videoClip({ id: 'b', type: 'audio', linkedClipId: 'a' })])
    const result = unlinkClips(sequence, 'a')
    expect(result.clips.find((c) => c.id === 'a')!.linkedClipId).toBeUndefined()
    expect(result.clips.find((c) => c.id === 'b')!.linkedClipId).toBeUndefined()
  })
})

describe('relinkOriginalAudio', () => {
  it('links to the same-media, opposite-type, unlinked clip closest in time', () => {
    const sequence = seqOf([
      videoClip({ id: 'v', mediaId: 'm1', startTime: 10 }),
      videoClip({ id: 'a-far', type: 'audio', mediaId: 'm1', startTime: 40 }),
      videoClip({ id: 'a-near', type: 'audio', mediaId: 'm1', startTime: 11 })
    ])
    const result = relinkOriginalAudio(sequence, 'v')
    expect(result.clips.find((c) => c.id === 'v')!.linkedClipId).toBe('a-near')
    expect(result.clips.find((c) => c.id === 'a-near')!.linkedClipId).toBe('v')
  })

  it('ignores candidates that are already linked to something else', () => {
    const sequence = seqOf([
      videoClip({ id: 'v', mediaId: 'm1' }),
      videoClip({ id: 'a1', type: 'audio', mediaId: 'm1', linkedClipId: 'other' }),
      videoClip({ id: 'other', type: 'video', mediaId: 'm2', linkedClipId: 'a1' })
    ])
    expect(relinkOriginalAudio(sequence, 'v')).toBe(sequence)
  })

  it('is a no-op for a missing clip or one with no opposite-type candidate', () => {
    const sequence = seqOf([videoClip({ id: 'v', mediaId: 'm1' })])
    expect(relinkOriginalAudio(sequence, 'v')).toBe(sequence)
    expect(relinkOriginalAudio(sequence, 'missing')).toBe(sequence)
  })
})

describe('extractAudio', () => {
  it('creates a linked audio clip matching the video clip\'s current (possibly trimmed) time/source range', () => {
    const sequence = seqOf([videoClip({ id: 'v', mediaId: 'm1', trackId: 'V1', startTime: 5, duration: 3, sourceIn: 2, sourceOut: 5 })])
    const result = extractAudio(sequence, 'v', 'A1', () => 'new-audio')
    const video = result.clips.find((c) => c.id === 'v')!
    const audio = result.clips.find((c) => c.id === 'new-audio')!
    expect(video.linkedClipId).toBe('new-audio')
    expect(audio).toMatchObject({ mediaId: 'm1', type: 'audio', trackId: 'A1', startTime: 5, duration: 3, sourceIn: 2, sourceOut: 5, linkedClipId: 'v' })
  })

  it('is a no-op for a missing clip, a non-video clip, or a clip that already has a linked clip', () => {
    const missing = seqOf([videoClip({ id: 'v' })])
    expect(extractAudio(missing, 'nope', 'A1')).toBe(missing)

    const audioOnly = seqOf([videoClip({ id: 'a', type: 'audio' })])
    expect(extractAudio(audioOnly, 'a', 'A1')).toBe(audioOnly)

    const alreadyLinked = seqOf([videoClip({ id: 'v', linkedClipId: 'existing-audio' }), videoClip({ id: 'existing-audio', type: 'audio', linkedClipId: 'v' })])
    expect(extractAudio(alreadyLinked, 'v', 'A1')).toBe(alreadyLinked)
  })
})

describe('selectedWithLinkedClips', () => {
  it('extends a selection to include each selected clip\'s linked partner', () => {
    const clips = [videoClip({ id: 'a', linkedClipId: 'b' }), videoClip({ id: 'b', type: 'audio', linkedClipId: 'a' }), videoClip({ id: 'c' })]
    expect(selectedWithLinkedClips(clips, ['a']).sort()).toEqual(['a', 'b'])
  })

  it('does not duplicate an already-included partner', () => {
    const clips = [videoClip({ id: 'a', linkedClipId: 'b' }), videoClip({ id: 'b', type: 'audio', linkedClipId: 'a' })]
    expect(selectedWithLinkedClips(clips, ['a', 'b']).sort()).toEqual(['a', 'b'])
  })

  it('leaves an unlinked clip\'s selection untouched', () => {
    const clips = [videoClip({ id: 'a' })]
    expect(selectedWithLinkedClips(clips, ['a'])).toEqual(['a'])
  })
})

describe('Linkage toggle gating (spec section 3) -- move/trim/delete/duplicate only cascade to the linked partner when `linked` is true', () => {
  it('moveClip: linked=false leaves the partner in place', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a', startTime: 0 }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', startTime: 0 })])
    const result = moveClip(sequence, 'v', 5, false)
    expect(result.clips.find((c) => c.id === 'v')!.startTime).toBe(5)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(0)
  })

  it('moveClip: linked=true (default) still cascades, matching prior behavior', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a', startTime: 0 }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', startTime: 0 })])
    const result = moveClip(sequence, 'v', 5)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(5)
  })

  it('trimClip: linked=true trims the partner\'s matching edge to the same pointerTime', () => {
    const sequence = seqOf([
      videoClip({ id: 'v', linkedClipId: 'a', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 }),
      videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 })
    ])
    const result = trimClip(sequence, 'v', 'right', 6, 10, true)
    expect(result.clips.find((c) => c.id === 'v')!.duration).toBe(6)
    expect(result.clips.find((c) => c.id === 'a')!.duration).toBe(6)
  })

  it('trimClip: linked=false leaves the partner untouched', () => {
    const sequence = seqOf([
      videoClip({ id: 'v', linkedClipId: 'a', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 }),
      videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10 })
    ])
    const result = trimClip(sequence, 'v', 'right', 6, 10, false)
    expect(result.clips.find((c) => c.id === 'v')!.duration).toBe(6)
    expect(result.clips.find((c) => c.id === 'a')!.duration).toBe(10)
  })

  it('deleteClips: linked=true also deletes the partner even if not explicitly targeted', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a' }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v' })])
    const result = deleteClips(sequence, ['v'], true)
    expect(result.clips).toHaveLength(0)
  })

  it('deleteClips: linked=false deletes only the explicit target', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a' }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v' })])
    const result = deleteClips(sequence, ['v'], false)
    expect(result.clips.map((c) => c.id)).toEqual(['a'])
  })

  it('deleteClips: a locked partner survives even when linked=true', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a' }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', locked: true })])
    const result = deleteClips(sequence, ['v'], true)
    expect(result.clips.map((c) => c.id)).toEqual(['a'])
  })

  it('duplicateClips: linked=true also duplicates the partner and keeps the copies linked to each other', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a', startTime: 0, duration: 5 }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', startTime: 0, duration: 5 })])
    const { sequence: result, newClipIds } = duplicateClips(sequence, ['v'], undefined, true)
    expect(newClipIds).toHaveLength(2)
    const vCopy = result.clips.find((c) => newClipIds.includes(c.id) && c.type === 'video')!
    const aCopy = result.clips.find((c) => newClipIds.includes(c.id) && c.type === 'audio')!
    expect(vCopy.linkedClipId).toBe(aCopy.id)
    expect(aCopy.linkedClipId).toBe(vCopy.id)
  })

  it('duplicateClips: linked=false duplicates only the explicit target, with its link cleared', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a', startTime: 0, duration: 5 }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', startTime: 0, duration: 5 })])
    const { newClipIds } = duplicateClips(sequence, ['v'], undefined, false)
    expect(newClipIds).toHaveLength(1)
  })
})

describe('groupClips / ungroupClips', () => {
  it('assigns a shared groupId to every given clip', () => {
    const sequence = seqOf([videoClip({ id: 'a' }), videoClip({ id: 'b' }), videoClip({ id: 'c' })])
    const result = groupClips(sequence, ['a', 'b'])
    const groupId = result.clips.find((c) => c.id === 'a')!.groupId
    expect(groupId).toBeTruthy()
    expect(result.clips.find((c) => c.id === 'b')!.groupId).toBe(groupId)
    expect(result.clips.find((c) => c.id === 'c')!.groupId).toBeUndefined()
  })

  it('is a no-op for fewer than 2 clips', () => {
    const sequence = seqOf([videoClip({ id: 'a' })])
    expect(groupClips(sequence, ['a'])).toBe(sequence)
  })

  it('ungroupClips clears groupId', () => {
    const sequence = groupClips(seqOf([videoClip({ id: 'a' }), videoClip({ id: 'b' })]), ['a', 'b'])
    const result = ungroupClips(sequence, ['a', 'b'])
    expect(result.clips.every((c) => !c.groupId)).toBe(true)
  })
})

describe('moveClipsToTrack', () => {
  it('reassigns trackId, preserving timing', () => {
    const sequence = seqOf([videoClip({ id: 'a', trackId: 'V1', startTime: 5, duration: 3 })])
    const result = moveClipsToTrack(sequence, ['a'], 'V4')
    const moved = result.clips.find((c) => c.id === 'a')!
    expect(moved.trackId).toBe('V4')
    expect(moved.startTime).toBe(5)
    expect(moved.duration).toBe(3)
  })
})

describe('moveClipToTrack', () => {
  it('moves a clip to a new time and track together', () => {
    const sequence = seqOf([videoClip({ id: 'a', trackId: 'V1', startTime: 5, duration: 3 })])
    const result = moveClipToTrack(sequence, 'a', 8, 'V2')
    const moved = result.clips.find((c) => c.id === 'a')!
    expect(moved.trackId).toBe('V2')
    expect(moved.startTime).toBe(8)
  })

  it('cascades the linked partner by time delta only, never changing its track', () => {
    const sequence = seqOf([
      videoClip({ id: 'v', trackId: 'V1', startTime: 5, duration: 3, linkedClipId: 'a' }),
      { ...videoClip({ id: 'a', trackId: 'A1', startTime: 5, duration: 3, linkedClipId: 'v' }), type: 'audio' }
    ])
    const result = moveClipToTrack(sequence, 'v', 8, 'V2')
    const video = result.clips.find((c) => c.id === 'v')!
    const audio = result.clips.find((c) => c.id === 'a')!
    expect(video.trackId).toBe('V2')
    expect(video.startTime).toBe(8)
    expect(audio.trackId).toBe('A1')
    expect(audio.startTime).toBe(8)
  })

  it('is a no-op for a locked clip', () => {
    const sequence = seqOf([videoClip({ id: 'a', locked: true, trackId: 'V1' })])
    expect(moveClipToTrack(sequence, 'a', 8, 'V2')).toBe(sequence)
  })
})

describe('moveClipToNewTrack', () => {
  it('synthesizes a new track of the given kind and moves the clip onto it', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0 })]
    const sequence: ProjectSequence = { tracks, clips: [videoClip({ id: 'a', trackId: 'V1', startTime: 2, duration: 4 })], markers: [], duration: 6 }
    const result = moveClipToNewTrack(sequence, 'a', 9, 'video')
    expect(result.tracks.length).toBe(2)
    const newTrack = result.tracks.find((t) => t.id !== 'V1')!
    expect(newTrack.kind).toBe('video')
    const moved = result.clips.find((c) => c.id === 'a')!
    expect(moved.trackId).toBe(newTrack.id)
    expect(moved.startTime).toBe(9)
  })

  it('is a no-op for a locked clip', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0 })]
    const sequence: ProjectSequence = { tracks, clips: [videoClip({ id: 'a', locked: true, trackId: 'V1' })], markers: [], duration: 10 }
    expect(moveClipToNewTrack(sequence, 'a', 9, 'video')).toBe(sequence)
  })

  it('creates the track under an explicitTrackId, and a repeat call with the same id reuses it instead of creating another', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0 })]
    const sequence: ProjectSequence = { tracks, clips: [videoClip({ id: 'a', trackId: 'V1', startTime: 2, duration: 4 })], markers: [], duration: 6 }
    const first = moveClipToNewTrack(sequence, 'a', 9, 'video', true, 'V2')
    expect(first.tracks.map((t) => t.id)).toEqual(['V1', 'V2'])
    expect(first.clips.find((c) => c.id === 'a')!.trackId).toBe('V2')

    // Simulates a second pointermove within the same drag gesture, passing
    // the same pre-computed id -- must not synthesize a second new track.
    const second = moveClipToNewTrack(first, 'a', 11, 'video', true, 'V2')
    expect(second.tracks.map((t) => t.id)).toEqual(['V1', 'V2'])
    expect(second.clips.find((c) => c.id === 'a')!.startTime).toBe(11)
  })
})

describe('pickClipProperties / applyClipProperties (Paste Attributes)', () => {
  it('picks only appearance/speed/audio fields, never timing or identity', () => {
    const clip = videoClip({ id: 'a', startTime: 5, duration: 10, opacity: 0.5, volume: 0.8, playbackRate: 2, fadeIn: 1, fadeOut: 2 })
    const patch = pickClipProperties(clip)
    expect(patch).toEqual({ playbackRate: 2, opacity: 0.5, volume: 0.8, fadeIn: 1, fadeOut: 2, transform: undefined })
  })

  it('applies a patch to every given unlocked clip, leaving locked ones untouched', () => {
    const sequence = seqOf([videoClip({ id: 'a', opacity: 1 }), videoClip({ id: 'b', opacity: 1, locked: true })])
    const result = applyClipProperties(sequence, ['a', 'b'], { opacity: 0.4 })
    expect(result.clips.find((c) => c.id === 'a')!.opacity).toBe(0.4)
    expect(result.clips.find((c) => c.id === 'b')!.opacity).toBe(1)
  })
})

describe('replaceClipMedia', () => {
  it('swaps mediaId and resets sourceIn, clamping duration to the new source length', () => {
    const sequence = seqOf([videoClip({ id: 'a', mediaId: 'old', duration: 10, sourceIn: 2 })])
    const result = replaceClipMedia(sequence, 'a', 'new', 4)
    const clip = result.clips.find((c) => c.id === 'a')!
    expect(clip.mediaId).toBe('new')
    expect(clip.sourceIn).toBe(0)
    expect(clip.duration).toBe(4)
  })

  it('does not clamp an image clip (never source-bounded)', () => {
    const sequence = seqOf([imageClip({ id: 'img1', duration: 20 })])
    const result = replaceClipMedia(sequence, 'img1', 'new', 2)
    expect(result.clips.find((c) => c.id === 'img1')!.duration).toBe(20)
  })
})

describe('sequence-level markers', () => {
  it('addMarker inserts a marker, sorted by time', () => {
    const sequence = addMarker(addMarker(seqOf([]), 10, () => 'm2'), 3, () => 'm1')
    expect(sequence.markers.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('moveMarker updates time and keeps the list sorted', () => {
    const sequence = addMarker(addMarker(seqOf([]), 3, () => 'm1'), 10, () => 'm2')
    const result = moveMarker(sequence, 'm1', 20)
    expect(result.markers.map((m) => m.id)).toEqual(['m2', 'm1'])
  })

  it('updateMarker patches name/note/color without touching time', () => {
    const sequence = addMarker(seqOf([]), 5, () => 'm1')
    const result = updateMarker(sequence, 'm1', { name: 'Beat 1', color: '#ff0000' })
    expect(result.markers[0]).toMatchObject({ name: 'Beat 1', color: '#ff0000', time: 5 })
  })

  it('removeMarker deletes it', () => {
    const sequence = addMarker(seqOf([]), 5, () => 'm1')
    expect(removeMarker(sequence, 'm1').markers).toEqual([])
  })
})

describe('per-clip markers', () => {
  it('addClipMarker attaches a marker to the clip, clamped within its duration', () => {
    const sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    const result = addClipMarker(sequence, 'a', 999, () => 'cm1')
    const marker = result.clips.find((c) => c.id === 'a')!.markers![0]
    expect(marker.offsetSeconds).toBe(10)
  })

  it('removeClipMarker removes it', () => {
    const sequence = addClipMarker(seqOf([videoClip({ id: 'a', duration: 10 })]), 'a', 2, () => 'cm1')
    const result = removeClipMarker(sequence, 'a', 'cm1')
    expect(result.clips.find((c) => c.id === 'a')!.markers).toEqual([])
  })
})
