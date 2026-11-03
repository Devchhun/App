import { describe, expect, it } from 'vitest'
import { createDefaultDubbingWorkspaceState, defaultDubbingSegmentState, referenceClipVerdict, reopenLinesWithLostAudio } from './dubbing'

describe('createDefaultDubbingWorkspaceState', () => {
  it('starts inactive, idle, with no segments', () => {
    expect(createDefaultDubbingWorkspaceState()).toEqual({ active: false, genderDetectionStatus: 'idle', segments: {}, speakers: {} })
  })
})

describe('defaultDubbingSegmentState', () => {
  it('starts pending/unknown with neutral pitch/speed/volume', () => {
    expect(defaultDubbingSegmentState('seg-1')).toEqual({
      segmentId: 'seg-1',
      detectedGender: 'unknown',
      pitch: 0,
      speed: 1,
      volumeDb: 0,
      status: 'pending'
    })
  })
})


// Thresholds come from measured clips in a real project: the 0.87 clip
// cloned every line at 0.83-0.93, the 0.78 clip never got above ~0.79.
describe('referenceClipVerdict', () => {
  it('calls a steady, clean clip good', () => {
    expect(referenceClipVerdict({ consistency: 0.869, clippedRatio: 0.0003, speechRatio: 0.99 })).toBe('good')
  })

  it('calls the clip that measured as drifting weak', () => {
    expect(referenceClipVerdict({ consistency: 0.784, clippedRatio: 0.0002, speechRatio: 0.99 })).toBe('weak')
  })

  it('is uncertain in between', () => {
    expect(referenceClipVerdict({ consistency: 0.80, clippedRatio: 0.0001, speechRatio: 0.99 })).toBe('fair')
  })

  it('treats heavy clipping or mostly-silence as weak regardless of consistency', () => {
    expect(referenceClipVerdict({ consistency: 0.9, clippedRatio: 0.01, speechRatio: 0.99 })).toBe('weak')
    expect(referenceClipVerdict({ consistency: 0.9, clippedRatio: 0, speechRatio: 0.3 })).toBe('weak')
  })
})

describe('reopenLinesWithLostAudio', () => {
  const line = (id: string, patch: Partial<ReturnType<typeof defaultDubbingSegmentState>>) => ({ ...defaultDubbingSegmentState(id), status: 'generated' as const, ...patch })

  it('puts lines whose clip lost its audio back to not made yet, and leaves the rest alone', () => {
    const state = {
      ...createDefaultDubbingWorkspaceState(),
      segments: {
        a: line('a', { generatedClipId: 'c1', voiceId: 'kiri:Kattt' }),
        b: line('b', { generatedClipId: 'c2' }),
        j: line('j', { generatedClipId: 'c1', joinedInto: 'a' }),
        t: line('t', { generatedClipId: 'c3', togetherClipIds: ['c4'] }),
        f: line('f', { status: 'pending' })
      }
    }
    const out = reopenLinesWithLostAudio(state, new Set(['c1', 'c4']))
    expect(out.segments.a.status).toBe('voice-assigned')
    expect(out.segments.a.generatedClipId).toBe('c1')
    expect(out.segments.j.status).toBe('pending')
    expect(out.segments.t.status).toBe('pending')
    expect(out.segments.b).toBe(state.segments.b)
    expect(out.segments.f).toBe(state.segments.f)
    // Nothing lost: the same state back.
    expect(reopenLinesWithLostAudio(state, new Set(['zz']))).toBe(state)
  })
})
