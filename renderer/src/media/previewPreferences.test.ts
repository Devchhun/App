import { describe, it, expect } from 'vitest'
import { parseStoredFitMode } from './previewPreferences'

describe('parseStoredFitMode', () => {
  it('round-trips a valid stored value', () => {
    expect(parseStoredFitMode('contain')).toBe('contain')
    expect(parseStoredFitMode('cover')).toBe('cover')
  })

  it('falls back to "contain" (Fit) for missing/corrupt/unrecognized values', () => {
    expect(parseStoredFitMode(null)).toBe('contain')
    expect(parseStoredFitMode('')).toBe('contain')
    expect(parseStoredFitMode('garbage')).toBe('contain')
  })
})
