import { describe, expect, it } from 'vitest'
import { createDefaultDubbingWorkspaceState, defaultDubbingSegmentState, referenceClipVerdict } from './dubbing'

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
