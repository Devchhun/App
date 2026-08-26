import { describe, it, expect } from 'vitest'
import { isPastRecordingBound } from './recordingBounds'

describe('isPastRecordingBound', () => {
  it('is false while still before the bound end', () => {
    expect(isPastRecordingBound(4.5, 5)).toBe(false)
  })

  it('is true once time reaches or passes the bound end', () => {
    expect(isPastRecordingBound(5, 5)).toBe(true)
    expect(isPastRecordingBound(5.2, 5)).toBe(true)
  })
})
