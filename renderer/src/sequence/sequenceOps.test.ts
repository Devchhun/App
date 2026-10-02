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
  moveClipSet,
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
  removeTrack,
  acceptNarrationTake,
  acceptDubbingClip,
  pickClipProperties,
  applyClipProperties,
  resetClipProperties,
  replaceClipMedia,
  addMarker,
  moveMarker,
  updateMarker,
  removeMarker,
  addClipMarker,
  removeClipMarker,
  addOrUpdateKeyframe,
  moveKeyframe,
  removeKeyframe,
  addMirroredAudioClips
} from './sequenceOps'
import { createEmptySequence } from '@shared/project'
import { updateClipSelection, clearClipSelection } from './sequenceSelection'
import { rippleTrim } from '../timeline/ripple'
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

describe('buildInsertedClips: video (no more auto-split linked audio clip)', () => {
  it('produces a single video clip, not a linked video+audio pair -- a plain import is one clip, matching the reference editor\'s own default of one clip per file until "Extract to Audio" is used explicitly', () => {
    idCounter = 0
    const inserted = buildInsertedClips({ mediaId: 'm1', type: 'video', sourceDurationSeconds: 10 }, 0, 'V1', makeId)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].type).toBe('video')
    expect(inserted[0].linkedClipId).toBeUndefined()
  })
})

describe('buildInsertedClips: optional overrides (e.g. AI Dubber muting the original video on insert)', () => {
  it('applies muted: true when passed, leaving every other field at its normal default', () => {
    idCounter = 0
    const [clip] = buildInsertedClips({ mediaId: 'm1', type: 'video', sourceDurationSeconds: 10 }, 0, 'V1', makeId, { muted: true })
    expect(clip.muted).toBe(true)
    expect(clip.locked).toBe(false)
  })

  it('leaves muted undefined when no overrides are given, same as before this param existed', () => {
    idCounter = 0
    const [clip] = buildInsertedClips({ mediaId: 'm1', type: 'video', sourceDurationSeconds: 10 }, 0, 'V1', makeId)
    expect(clip.muted).toBeUndefined()
  })
})

describe('insertClip: a plain video import never creates or touches an audio track', () => {
  it('inserts only the one video clip, leaving A1 untouched even when it already has content', () => {
    const a1 = track({ id: 'A1', kind: 'audio', order: 0 })
    const existing: TimelineClip = { id: 'existing-a', mediaId: 'm0', type: 'audio', trackId: 'A1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false }
    const sequence: ProjectSequence = { tracks: [a1], clips: [existing], markers: [], duration: 10 }
    const result = insertClip(sequence, { mediaId: 'm1', type: 'video', sourceDurationSeconds: 10 }, 0, 'V1', makeId)
    expect(result.clips.filter((c) => c.type === 'video')).toHaveLength(1)
    expect(result.clips.find((c) => c.id === 'existing-a')).toEqual(existing)
    expect(result.tracks).toEqual(sequence.tracks)
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
      const linked = result.clips.find((other) => other.id === piece.linkedClipId)
      expect(linked?.linkedClipId).toBe(piece.id)
      expect(linked?.startTime).toBe(piece.startTime)
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
    expect(result.clips.find((c) => c.id === 'a1')?.linkedClipId).toBeUndefined()
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

describe('Gap-Aware Ripple Insert (moveClip same-track collision handling)', () => {
  it('snaps into an existing gap without moving anything else', () => {
    const sequence = seqOf([
      videoClip({ id: 'a', startTime: 0, duration: 5 }),
      videoClip({ id: 'moving', startTime: 30, duration: 3 }),
      videoClip({ id: 'b', startTime: 15, duration: 5 })
    ])
    const moved = moveClip(sequence, 'moving', 8) // gap [5,15) fits a 3s clip at 8
    expect(moved.clips.find((c) => c.id === 'moving')!.startTime).toBe(8)
    expect(moved.clips.find((c) => c.id === 'a')!.startTime).toBe(0)
    expect(moved.clips.find((c) => c.id === 'b')!.startTime).toBe(15)
  })

  it('ripple-pushes the overlapping clip and everything after it, never overlapping', () => {
    const sequence = seqOf([
      videoClip({ id: 'a', startTime: 0, duration: 5 }),
      videoClip({ id: 'moving', startTime: 30, duration: 4 }),
      videoClip({ id: 'b', startTime: 6, duration: 5 }), // only a 1s gap after 'a' -- too small for the 4s moving clip
      videoClip({ id: 'c', startTime: 11, duration: 5 })
    ])
    const moved = moveClip(sequence, 'moving', 5)
    expect(moved.clips.find((c) => c.id === 'moving')!.startTime).toBe(5)
    expect(moved.clips.find((c) => c.id === 'b')!.startTime).toBe(9) // pushed to right after moving's new end
    expect(moved.clips.find((c) => c.id === 'c')!.startTime).toBe(14) // pushed right behind b
    expect(moved.clips.find((c) => c.id === 'a')!.startTime).toBe(0) // untouched, entirely before the insertion point
  })

  it('never routes to a different track or auto-creates one to dodge a collision', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 0, duration: 10 }), videoClip({ id: 'moving', trackId: 'V1', startTime: 30, duration: 4 })])
    const moved = moveClip(sequence, 'moving', 3) // fully overlaps 'a'
    expect(moved.clips.find((c) => c.id === 'moving')!.trackId).toBe('V1')
    expect(moved.tracks).toEqual(sequence.tracks) // no new track synthesized
  })

  it('pushes a ripple-displaced clip\'s own linked partner on another track to stay in sync', () => {
    const sequence = seqOf([
      videoClip({ id: 'a', startTime: 0, duration: 5 }),
      videoClip({ id: 'moving', startTime: 30, duration: 4 }),
      videoClip({ id: 'b', startTime: 2, duration: 5, linkedClipId: 'b-audio' }), // overlaps the moving clip's target position
      { id: 'b-audio', mediaId: 'm1', type: 'audio', trackId: 'A1', startTime: 2, duration: 5, sourceIn: 0, sourceOut: 5, locked: false, linkedClipId: 'b' } as TimelineClip
    ])
    const moved = moveClip(sequence, 'moving', 0)
    const newBStart = moved.clips.find((c) => c.id === 'b')!.startTime
    expect(newBStart).toBeGreaterThan(2) // b got pushed
    expect(moved.clips.find((c) => c.id === 'b-audio')!.startTime).toBe(newBStart) // its audio partner followed by the same delta
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

  it('clears a surviving clip\'s stale linkedClipId when its partner falls inside the deleted range', () => {
    const sequence = seqOf([
      videoClip({ id: 'v', trackId: 'V1', startTime: 5, duration: 5, linkedClipId: 'a' }), // [5,10) -- inside the range, deleted
      videoClip({ id: 'a', trackId: 'A1', type: 'audio', startTime: 50, duration: 5, linkedClipId: 'v' }) // outside the range, survives
    ])
    const result = deleteTimeRange(sequence, { start: 0, end: 20 })
    expect(result.clips.map((c) => c.id)).toEqual(['a'])
    expect(result.clips[0].linkedClipId).toBeUndefined()
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

describe('moveClipSet', () => {
  it('moves selected clips together while preserving their relative spacing', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 1, duration: 2 }), videoClip({ id: 'b', startTime: 6, duration: 2 })])
    const result = moveClipSet(sequence, 'a', ['a', 'b'], 3, false)
    expect(result.clips.map((c) => c.startTime)).toEqual([3, 8])
  })

  it('clamps the whole selection at zero and at an external clip', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 1, duration: 2 }), videoClip({ id: 'b', startTime: 6, duration: 2 }), videoClip({ id: 'wall', startTime: 10, duration: 2 })])
    expect(moveClipSet(sequence, 'a', ['a', 'b'], -5, false).clips.map((c) => c.startTime)).toEqual([0, 5, 10])
    expect(moveClipSet(sequence, 'a', ['a', 'b'], 9, false).clips.map((c) => c.startTime)).toEqual([3, 8, 10])
  })
})

describe('speed-aware clip edits', () => {
  it('retimes the source window, splits at the right source frame, and trims in source seconds', () => {
    const original = seqOf([videoClip({ id: 'v', duration: 10, sourceOut: 10 })])
    const fast = applyClipProperties(original, ['v'], { playbackRate: 2 })
    expect(fast.clips[0]).toMatchObject({ duration: 5, sourceIn: 0, sourceOut: 10, playbackRate: 2 })
    const pieces = splitClip(fast, 'v', 2, { makeId }).clips
    expect(pieces[0]).toMatchObject({ duration: 2, sourceIn: 0, sourceOut: 4 })
    expect(pieces[1]).toMatchObject({ startTime: 2, duration: 3, sourceIn: 4, sourceOut: 10 })
    expect(trimClip(fast, 'v', 'right', 3, 10).clips[0]).toMatchObject({ duration: 3, sourceOut: 6 })
  })

  it('keeps a linked audio partner at the same rate and bounds both on trim', () => {
    const video = videoClip({ id: 'v', duration: 10, sourceOut: 10, linkedClipId: 'a' })
    const audio = videoClip({ id: 'a', type: 'audio', trackId: 'A1', duration: 10, sourceOut: 10, linkedClipId: 'v' })
    const fast = applyClipProperties(seqOf([video, audio]), ['v'], { playbackRate: 2 })
    expect(fast.clips.map((c) => c.duration)).toEqual([5, 5])
    expect(fast.clips.map((c) => c.playbackRate)).toEqual([2, 2])
    const trimmed = trimClip(fast, 'v', 'right', 8, 20, true, 10)
    expect(trimmed.clips.map((c) => c.duration)).toEqual([5, 5])
  })

  it('slowing a clip makes room for its following neighbour', () => {
    const sequence = seqOf([videoClip({ id: 'v', duration: 10 }), videoClip({ id: 'next', startTime: 10, duration: 3, sourceOut: 3 })])
    const slowed = applyClipProperties(sequence, ['v'], { playbackRate: 0.5 })
    expect(slowed.clips[0].duration).toBe(20)
    expect(slowed.clips[1].startTime).toBe(20)
  })

  it('does not grow a clip through a locked neighbour', () => {
    const sequence = seqOf([videoClip({ id: 'v', duration: 10 }), videoClip({ id: 'locked', startTime: 10, duration: 3, sourceOut: 3, locked: true })])
    const result = applyClipProperties(sequence, ['v'], { playbackRate: 0.5 })
    expect(result.clips[0].duration).toBe(10)
    expect(result.clips[0].playbackRate).toBeUndefined()
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
    // Realistic linked pair: video on V1, its own audio on A1 -- a linked
    // pair sharing one track (as this test previously had it, unrealistically)
    // would now also trigger Gap-Aware Ripple Insert's same-track collision
    // handling, which is a deliberately separate concern from the linked
    // cascade this test is actually about.
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a', startTime: 0 }), videoClip({ id: 'a', type: 'audio', trackId: 'A1', linkedClipId: 'v', startTime: 0 })])
    const result = moveClip(sequence, 'v', 5, false)
    expect(result.clips.find((c) => c.id === 'v')!.startTime).toBe(5)
    expect(result.clips.find((c) => c.id === 'a')!.startTime).toBe(0)
  })

  it('moveClip: linked=true (default) still cascades, matching prior behavior', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a', startTime: 0 }), videoClip({ id: 'a', type: 'audio', trackId: 'A1', linkedClipId: 'v', startTime: 0 })])
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

  // Regression coverage for the stale-link cleanup requirement: a locked
  // partner survives its now-deleted target above, but was left with a
  // linkedClipId pointing at a clip that no longer exists -- still showing
  // the 🔗 "linked" badge for a partner that isn't there anymore.
  it('deleteClips (Plain Delete): clears the surviving locked partner\'s now-stale linkedClipId', () => {
    const sequence = seqOf([videoClip({ id: 'v', linkedClipId: 'a' }), videoClip({ id: 'a', type: 'audio', linkedClipId: 'v', locked: true })])
    const result = deleteClips(sequence, ['v'], true)
    expect(result.clips.find((c) => c.id === 'a')!.linkedClipId).toBeUndefined()
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

  it('never lands on top of a clip already on the destination track -- that clip is pushed right', () => {
    const sequence = seqOf([
      videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 4 }),
      videoClip({ id: 'b', trackId: 'V2', startTime: 2, duration: 5 })
    ])
    const result = moveClipToTrack(sequence, 'a', 1, 'V2')
    const a = result.clips.find((c) => c.id === 'a')!
    const b = result.clips.find((c) => c.id === 'b')!
    expect(a.trackId).toBe('V2')
    expect(a.startTime).toBe(1)
    // b now starts exactly where a ends
    expect(b.startTime).toBe(5)
  })
})

describe('overlap guards', () => {
  it('a plain right-edge trim stops at the next clip on the track', () => {
    const sequence = seqOf([videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }), videoClip({ id: 'b', trackId: 'V1', startTime: 5, duration: 3 })])
    const result = trimClip(sequence, 'a', 'right', 7, 100)
    expect(result.clips.find((c) => c.id === 'a')!.duration).toBe(5)
  })

  it('a plain left-edge trim stops at the previous clip on the track', () => {
    const sequence = seqOf([videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 }), videoClip({ id: 'b', trackId: 'V1', startTime: 5, duration: 3, sourceIn: 4 })])
    const result = trimClip(sequence, 'b', 'left', 1, 100)
    expect(result.clips.find((c) => c.id === 'b')!.startTime).toBe(3)
  })

  it('insertClip pushes what already sits at that time on the track', () => {
    const sequence = seqOf([videoClip({ id: 'a', trackId: 'V1', startTime: 2, duration: 4 })])
    const result = insertClip(sequence, { mediaId: 'm', kind: 'video', fileName: 'x.mp4', sourceDurationSeconds: 3, hasAudio: false } as never, 1, 'V1')
    const a = result.clips.find((c) => c.id === 'a')!
    expect(a.startTime).toBe(4)
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

describe('removeTrack', () => {
  it('removes every clip that was on the deleted track along with it', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'V2', kind: 'video', order: 1 })]
    const sequence: ProjectSequence = {
      tracks,
      clips: [videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), videoClip({ id: 'b', trackId: 'V2', startTime: 0, duration: 5 })],
      markers: [],
      duration: 10
    }
    const result = removeTrack(sequence, 'V2')
    expect(result.tracks.map((t) => t.id)).toEqual(['V1'])
    // Without this, clip 'b' would remain in `clips` with a trackId that no
    // longer exists in `tracks` -- unrenderable and unselectable through any
    // normal UI action, yet still counted toward duration/export.
    expect(result.clips.map((c) => c.id)).toEqual(['a'])
  })

  it('leaves clips on OTHER tracks untouched', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 })]
    const sequence: ProjectSequence = {
      tracks,
      clips: [videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), videoClip({ id: 'b', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' })],
      markers: [],
      duration: 10
    }
    const result = removeTrack(sequence, 'A1')
    expect(result.clips.map((c) => c.id)).toEqual(['a'])
  })

  it('clears the surviving clip\'s stale linkedClipId when its partner was on the removed track', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'A1', kind: 'audio', order: 0 })]
    const sequence: ProjectSequence = {
      tracks,
      clips: [
        videoClip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a' }),
        videoClip({ id: 'a', trackId: 'A1', type: 'audio', startTime: 0, duration: 5, linkedClipId: 'v' })
      ],
      markers: [],
      duration: 10
    }
    const result = removeTrack(sequence, 'A1')
    const survivor = result.clips.find((c) => c.id === 'v')!
    // Without this, the surviving video clip would still show the 🔗
    // "linked" badge (ClipTrack.tsx renders it purely off `linkedClipId`
    // truthiness) for a partner that no longer exists anywhere.
    expect(survivor.linkedClipId).toBeUndefined()
  })

  it('is a no-op (same sequence reference) for a non-removable track, e.g. the main video track', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0, isMain: true, removable: false })]
    const sequence: ProjectSequence = { tracks, clips: [videoClip({ id: 'a', trackId: 'V1' })], markers: [], duration: 10 }
    expect(removeTrack(sequence, 'V1')).toBe(sequence)
  })

  it('is a no-op for an unknown track id', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0, isMain: true })]
    const sequence: ProjectSequence = { tracks, clips: [], markers: [], duration: 0 }
    expect(removeTrack(sequence, 'does-not-exist')).toBe(sequence)
  })

  it('recomputes duration from the surviving clips', () => {
    const tracks: TimelineTrack[] = [track({ id: 'V1', kind: 'video', order: 0, isMain: true }), track({ id: 'V2', kind: 'video', order: 1 })]
    const sequence: ProjectSequence = {
      tracks,
      clips: [videoClip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), videoClip({ id: 'b', trackId: 'V2', startTime: 50, duration: 5 })],
      markers: [],
      duration: 60
    }
    const result = removeTrack(sequence, 'V2')
    expect(result.duration).toBe(computeSequenceDuration([sequence.clips[0]]))
  })
})

describe('acceptNarrationTake (Story Narration Workspace "Accept & Next")', () => {
  const takeAsset = (mediaId: string, sourceDurationSeconds = 3): { mediaId: string; type: 'audio'; sourceDurationSeconds: number } => ({
    mediaId,
    type: 'audio',
    sourceDurationSeconds
  })

  it('inserts the take at the exact given start time on the given track', () => {
    const sequence = seqOf([])
    const { sequence: result, clipId } = acceptNarrationTake(sequence, 'VO1', 12.5, takeAsset('take-1'))
    const clip = result.clips.find((c) => c.id === clipId)!
    expect(clip.startTime).toBe(12.5)
    expect(clip.trackId).toBe('VO1')
    expect(clip.mediaId).toBe('take-1')
  })

  it('replaces a previously-accepted take for the same segment -- never leaves two clips', () => {
    const sequence = seqOf([])
    const first = acceptNarrationTake(sequence, 'VO1', 5, takeAsset('take-1'))
    const second = acceptNarrationTake(first.sequence, 'VO1', 5, takeAsset('take-2'), first.clipId)

    const vo1Clips = second.sequence.clips.filter((c) => c.trackId === 'VO1')
    expect(vo1Clips).toHaveLength(1)
    expect(vo1Clips[0].mediaId).toBe('take-2')
    expect(vo1Clips[0].id).toBe(second.clipId)
    expect(vo1Clips[0].id).not.toBe(first.clipId)
  })

  it('leaves other clips on the same track untouched when replacing a take', () => {
    const other = videoClip({ id: 'other-vo', mediaId: 'm-other', type: 'audio', trackId: 'VO1', startTime: 30, duration: 3 })
    const sequence = seqOf([other])
    const first = acceptNarrationTake(sequence, 'VO1', 5, takeAsset('take-1'))
    const second = acceptNarrationTake(first.sequence, 'VO1', 5, takeAsset('take-2'), first.clipId)
    expect(second.sequence.clips.find((c) => c.id === 'other-vo')).toBeDefined()
  })

  it('recomputes duration to include the newly-accepted take', () => {
    const sequence = seqOf([])
    const { sequence: result } = acceptNarrationTake(sequence, 'VO1', 100, takeAsset('take-1', 4))
    expect(result.duration).toBe(computeSequenceDuration(result.clips))
    expect(result.duration).toBeGreaterThan(104)
  })

  it('routes an overlapping take onto VO2 instead of overlapping VO1 (regression: recording can now run past its SRT segment -- see NarrationContext.tsx -- so an adjacent segment\'s accepted take can genuinely overlap the next one)', () => {
    const sequence = seqOf([])
    // Segment A's take runs long, spilling into segment B's own [10, 13) start.
    const a = acceptNarrationTake(sequence, 'VO1', 5, takeAsset('take-a', 8))
    const b = acceptNarrationTake(a.sequence, 'VO1', 10, takeAsset('take-b', 3))

    const clipA = b.sequence.clips.find((c) => c.id === a.clipId)!
    const clipB = b.sequence.clips.find((c) => c.id === b.clipId)!
    expect(clipA.trackId).toBe('VO1')
    expect(clipB.trackId).toBe('VO2')
    expect(b.sequence.tracks.some((t) => t.id === 'VO2' && t.kind === 'audio')).toBe(true)
  })

  it('re-accepting the same segment at the same spot stays on VO1 -- excludes its own previous clip from the collision check', () => {
    const sequence = seqOf([])
    const first = acceptNarrationTake(sequence, 'VO1', 5, takeAsset('take-1', 3))
    const second = acceptNarrationTake(first.sequence, 'VO1', 5, takeAsset('take-2', 3), first.clipId)
    const clip = second.sequence.clips.find((c) => c.id === second.clipId)!
    expect(clip.trackId).toBe('VO1')
  })
})

describe('acceptDubbingClip (AI Dubber "Generate Dubbing", mirrors acceptNarrationTake)', () => {
  const dubAsset = (mediaId: string, sourceDurationSeconds = 3): { mediaId: string; type: 'audio'; sourceDurationSeconds: number } => ({
    mediaId,
    type: 'audio',
    sourceDurationSeconds
  })

  it('inserts the generated clip at the exact given start time on the given track', () => {
    const sequence = seqOf([])
    const { sequence: result, clipId } = acceptDubbingClip(sequence, 'DUB1', 12.5, dubAsset('dub-1'))
    const clip = result.clips.find((c) => c.id === clipId)!
    expect(clip.startTime).toBe(12.5)
    expect(clip.trackId).toBe('DUB1')
    expect(clip.mediaId).toBe('dub-1')
  })

  it('replaces a previously-generated clip for the same subtitle -- never leaves two clips', () => {
    const sequence = seqOf([])
    const first = acceptDubbingClip(sequence, 'DUB1', 5, dubAsset('dub-1'))
    const second = acceptDubbingClip(first.sequence, 'DUB1', 5, dubAsset('dub-2'), first.clipId)

    const dub1Clips = second.sequence.clips.filter((c) => c.trackId === 'DUB1')
    expect(dub1Clips).toHaveLength(1)
    expect(dub1Clips[0].mediaId).toBe('dub-2')
    expect(dub1Clips[0].id).toBe(second.clipId)
    expect(dub1Clips[0].id).not.toBe(first.clipId)
  })

  it('routes an overlapping generated clip onto DUB2 instead of overlapping DUB1', () => {
    const sequence = seqOf([])
    const a = acceptDubbingClip(sequence, 'DUB1', 5, dubAsset('dub-a', 8))
    const b = acceptDubbingClip(a.sequence, 'DUB1', 10, dubAsset('dub-b', 3))

    const clipA = b.sequence.clips.find((c) => c.id === a.clipId)!
    const clipB = b.sequence.clips.find((c) => c.id === b.clipId)!
    expect(clipA.trackId).toBe('DUB1')
    expect(clipB.trackId).toBe('DUB2')
    expect(b.sequence.tracks.some((t) => t.id === 'DUB2' && t.kind === 'audio')).toBe(true)
  })

  it('re-generating the same subtitle at the same spot stays on DUB1 -- excludes its own previous clip from the collision check', () => {
    const sequence = seqOf([])
    const first = acceptDubbingClip(sequence, 'DUB1', 5, dubAsset('dub-1', 3))
    const second = acceptDubbingClip(first.sequence, 'DUB1', 5, dubAsset('dub-2', 3), first.clipId)
    const clip = second.sequence.clips.find((c) => c.id === second.clipId)!
    expect(clip.trackId).toBe('DUB1')
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

  it('picks up a keyframed clip\'s keyframes too, so Paste Attributes carries the animation across', () => {
    const keyframes = { opacity: [{ id: 'k1', time: 0, value: 0 }] }
    const clip = videoClip({ id: 'a', keyframes })
    expect(pickClipProperties(clip).keyframes).toEqual(keyframes)
  })

  it('applying a picked patch with keyframes actually installs them on the target clip', () => {
    const source = videoClip({ id: 'a', keyframes: { opacity: [{ id: 'k1', time: 0, value: 0 }] } })
    const sequence = seqOf([source, videoClip({ id: 'b' })])
    const result = applyClipProperties(sequence, ['b'], pickClipProperties(source))
    expect(result.clips.find((c) => c.id === 'b')!.keyframes).toEqual(source.keyframes)
  })
})

describe('resetClipProperties', () => {
  it('clears every adjustable field back to its un-adjusted default, including any keyframes', () => {
    const sequence = seqOf([
      videoClip({
        id: 'a',
        opacity: 0.4,
        volume: 0.2,
        playbackRate: 2,
        fadeIn: 1,
        fadeOut: 1,
        transform: { x: 5, y: 5, scaleX: -1, scaleY: 1, rotation: 90, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
        keyframes: { opacity: [{ id: 'k1', time: 0, value: 0 }] }
      })
    ])
    const result = resetClipProperties(sequence, ['a'])
    const clip = result.clips.find((c) => c.id === 'a')!
    expect(clip.opacity).toBe(1)
    expect(clip.volume).toBe(1)
    expect(clip.playbackRate).toBe(1)
    expect(clip.keyframes).toBeUndefined()
    expect(clip.fadeIn).toBe(0)
    expect(clip.fadeOut).toBe(0)
    expect(clip.transform).toBeUndefined()
  })

  it('never touches timing, track, media, or link identity', () => {
    const sequence = seqOf([videoClip({ id: 'a', startTime: 5, duration: 10, trackId: 'V1', mediaId: 'm1', linkedClipId: 'b', opacity: 0.5 })])
    const result = resetClipProperties(sequence, ['a'])
    const clip = result.clips.find((c) => c.id === 'a')!
    expect(clip.startTime).toBe(5)
    expect(clip.duration).toBe(10)
    expect(clip.trackId).toBe('V1')
    expect(clip.mediaId).toBe('m1')
    expect(clip.linkedClipId).toBe('b')
  })

  it('leaves a locked clip untouched', () => {
    const sequence = seqOf([videoClip({ id: 'a', opacity: 0.3, locked: true })])
    const result = resetClipProperties(sequence, ['a'])
    expect(result.clips.find((c) => c.id === 'a')!.opacity).toBe(0.3)
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

describe('keyframe animation (Keyframe Animation feature)', () => {
  it('addOrUpdateKeyframe creates the first keyframe for a property, clamped within the clip\'s own duration', () => {
    const sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    const result = addOrUpdateKeyframe(sequence, 'a', 'opacity', 999, 0.5, undefined, () => 'kf1')
    const keyframes = result.clips.find((c) => c.id === 'a')!.keyframes!.opacity!
    expect(keyframes).toEqual([{ id: 'kf1', time: 10, value: 0.5, easing: undefined }])
  })

  it('a second addOrUpdateKeyframe at a NEW time appends, keeping the first', () => {
    let sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    sequence = addOrUpdateKeyframe(sequence, 'a', 'opacity', 0, 0, undefined, () => 'kf1')
    sequence = addOrUpdateKeyframe(sequence, 'a', 'opacity', 5, 1, undefined, () => 'kf2')
    const keyframes = sequence.clips.find((c) => c.id === 'a')!.keyframes!.opacity!
    expect(keyframes.map((k) => k.id)).toEqual(['kf1', 'kf2'])
  })

  it('addOrUpdateKeyframe at an EXISTING keyframe\'s exact time overwrites its value instead of duplicating', () => {
    let sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    sequence = addOrUpdateKeyframe(sequence, 'a', 'opacity', 5, 0.2, undefined, () => 'kf1')
    sequence = addOrUpdateKeyframe(sequence, 'a', 'opacity', 5, 0.9, undefined, () => 'kf2')
    const keyframes = sequence.clips.find((c) => c.id === 'a')!.keyframes!.opacity!
    expect(keyframes).toHaveLength(1)
    expect(keyframes[0]).toEqual({ id: 'kf1', time: 5, value: 0.9, easing: undefined })
  })

  it('keyframing one property never touches another property\'s own keyframes on the same clip', () => {
    let sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    sequence = addOrUpdateKeyframe(sequence, 'a', 'opacity', 0, 1, undefined, () => 'kf1')
    sequence = addOrUpdateKeyframe(sequence, 'a', 'x', 0, 50, undefined, () => 'kf2')
    const clip = sequence.clips.find((c) => c.id === 'a')!
    expect(clip.keyframes!.opacity).toHaveLength(1)
    expect(clip.keyframes!.x).toHaveLength(1)
  })

  it('is a no-op on a locked clip', () => {
    const sequence = seqOf([videoClip({ id: 'a', duration: 10, locked: true })])
    const result = addOrUpdateKeyframe(sequence, 'a', 'opacity', 0, 1, undefined, () => 'kf1')
    expect(result.clips.find((c) => c.id === 'a')!.keyframes).toBeUndefined()
  })

  it('moveKeyframe repositions it in time, clamped to the clip\'s duration, without touching its value', () => {
    let sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    sequence = addOrUpdateKeyframe(sequence, 'a', 'rotation', 2, 90, undefined, () => 'kf1')
    sequence = moveKeyframe(sequence, 'a', 'rotation', 'kf1', 999)
    const keyframe = sequence.clips.find((c) => c.id === 'a')!.keyframes!.rotation![0]
    expect(keyframe).toEqual({ id: 'kf1', time: 10, value: 90, easing: undefined })
  })

  it('removeKeyframe deletes it, leaving other keyframes on the same property untouched', () => {
    let sequence = seqOf([videoClip({ id: 'a', duration: 10 })])
    sequence = addOrUpdateKeyframe(sequence, 'a', 'volume', 0, 1, undefined, () => 'kf1')
    sequence = addOrUpdateKeyframe(sequence, 'a', 'volume', 5, 0, undefined, () => 'kf2')
    sequence = removeKeyframe(sequence, 'a', 'volume', 'kf1')
    const keyframes = sequence.clips.find((c) => c.id === 'a')!.keyframes!.volume!
    expect(keyframes.map((k) => k.id)).toEqual(['kf2'])
  })
})

describe('an image can be dragged longer (it has no source end)', () => {
  // Images probe as a single frame (~0.04 s); that must never cap a trim.
  it('trimClip extends an image past its probed length', () => {
    const next = trimClip(seqOf([imageClip({ id: 'img', startTime: 0, duration: 1.5 })]), 'img', 'right', 12, 0.04)
    expect(next.clips.find((c) => c.id === 'img')!.duration).toBeCloseTo(12)
  })
  it('rippleTrim extends it too', () => {
    const next = rippleTrim(seqOf([imageClip({ id: 'img', startTime: 0, duration: 1.5 })]), 'img', 'right', 9, 'current', 0.04)
    expect(next.clips.find((c) => c.id === 'img')!.duration).toBeCloseTo(9)
  })
  it('a video is still capped at its real length', () => {
    const next = trimClip(seqOf([videoClip({ id: 'v', startTime: 0, duration: 2, sourceIn: 0, sourceOut: 2 })]), 'v', 'right', 12, 3)
    expect(next.clips.find((c) => c.id === 'v')!.duration).toBeCloseTo(3)
  })
})

describe('addMirroredAudioClips', () => {
  it('puts the instrumental under each clip exactly like the clip, and mutes the clip', () => {
    const seq = {
      ...createEmptySequence(),
      clips: [
        { id: 'v1', mediaId: 'film', type: 'video' as const, trackId: 'V1', startTime: 0, duration: 77, sourceIn: 0, sourceOut: 77, locked: false },
        { id: 'v2', mediaId: 'film', type: 'video' as const, trackId: 'V1', startTime: 77, duration: 2, sourceIn: 77, sourceOut: 78.7, locked: false, playbackRate: 0.85 }
      ]
    }
    let n = 0
    const next = addMirroredAudioClips(seq, ['v1', 'v2'], 'instrumental', () => `a${++n}`)
    const audio = next.clips.filter((c) => c.mediaId === 'instrumental')
    expect(audio.map((c) => [c.startTime, c.duration, c.sourceIn, c.sourceOut, c.playbackRate ?? 1])).toEqual([
      [0, 77, 0, 77, 1],
      [77, 2, 77, 78.7, 0.85]
    ])
    // Both on one audio track (they do not overlap).
    expect(new Set(audio.map((c) => c.trackId)).size).toBe(1)
    expect(next.tracks.find((t) => t.id === audio[0].trackId)?.kind).toBe('audio')
    expect(next.clips.filter((c) => c.type === 'video').every((c) => c.muted)).toBe(true)
    // Pressed again: nothing doubled.
    expect(addMirroredAudioClips(next, ['v1', 'v2'], 'instrumental', () => `b${++n}`).clips.length).toBe(next.clips.length)
  })
})
