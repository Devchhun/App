import { describe, expect, it, beforeEach } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { copyToClipboard, getClipboard, clearClipboard, pasteClipsAt } from './clipClipboard'

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, locked: false, ...overrides }
}

function seq(clips: TimelineClip[]): ProjectSequence {
  return { tracks: [], clips, markers: [], duration: computeSequenceDuration(clips) }
}

let idCounter = 0
function makeId(): string {
  idCounter += 1
  return `paste-${idCounter}`
}

beforeEach(() => {
  clearClipboard()
  idCounter = 0
})

describe('copyToClipboard / getClipboard', () => {
  it('starts empty', () => {
    expect(getClipboard()).toBeNull()
  })

  it('stores a snapshot decoupled from the original array', () => {
    const original = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })]
    copyToClipboard(original)
    original[0].startTime = 999
    expect(getClipboard()!.clips[0].startTime).toBe(0)
  })
})

describe('pasteClipsAt', () => {
  it('returns the sequence unchanged when the clipboard is empty', () => {
    const s = seq([])
    const result = pasteClipsAt(s, 10, 'V1', makeId)
    expect(result.sequence).toBe(s)
    expect(result.newClipIds).toEqual([])
  })

  it('pastes at the given time, preserving relative offsets between copied clips', () => {
    copyToClipboard([clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 3 }), clip({ id: 'b', trackId: 'V1', startTime: 10, duration: 2 })])
    const result = pasteClipsAt(seq([]), 20, 'V1', makeId)
    const pasted = result.sequence.clips.sort((x, y) => x.startTime - y.startTime)
    expect(pasted[0].startTime).toBe(20)
    expect(pasted[1].startTime).toBe(25) // preserved the original 5s gap
  })

  it('assigns fresh ids to the pasted clips', () => {
    copyToClipboard([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 3 })])
    const result = pasteClipsAt(seq([]), 0, 'V1', makeId)
    expect(result.newClipIds).toEqual(['paste-1'])
    expect(result.sequence.clips[0].id).not.toBe('a')
  })

  it('keeps a linked pair linked to each other only if both were copied', () => {
    copyToClipboard([
      clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a' }),
      clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio', linkedClipId: 'v' })
    ])
    const result = pasteClipsAt(seq([]), 10, 'V1', makeId)
    const v = result.sequence.clips.find((c) => c.type === 'video')!
    const a = result.sequence.clips.find((c) => c.type === 'audio')!
    expect(v.linkedClipId).toBe(a.id)
    expect(a.linkedClipId).toBe(v.id)
  })

  it('clears the link when only one side of a pair was copied', () => {
    copyToClipboard([clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a' })])
    const result = pasteClipsAt(seq([]), 0, 'V1', makeId)
    expect(result.sequence.clips[0].linkedClipId).toBeUndefined()
  })

  it('a second copied clip on a different track keeps its own track, not the paste target', () => {
    copyToClipboard([
      clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5 }),
      clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' })
    ])
    const result = pasteClipsAt(seq([]), 0, 'V4', makeId)
    expect(result.sequence.clips.find((c) => c.type === 'video')!.trackId).toBe('V4')
    expect(result.sequence.clips.find((c) => c.type === 'audio')!.trackId).toBe('A1')
  })

  it('pasted clips never inherit lock or group membership', () => {
    copyToClipboard([clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, locked: true, groupId: 'g1' })])
    const result = pasteClipsAt(seq([]), 0, 'V1', makeId)
    expect(result.sequence.clips[0].locked).toBe(false)
    expect(result.sequence.clips[0].groupId).toBeUndefined()
  })
})
