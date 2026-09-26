import { describe, expect, it } from 'vitest'
import { stripFileExtension } from './format'

describe('stripFileExtension', () => {
  it('drops a normal short extension', () => {
    expect(stripFileExtension('01.mp4')).toBe('01')
    expect(stripFileExtension('Interview.mov')).toBe('Interview')
    expect(stripFileExtension('song.mp3')).toBe('song')
  })

  it('leaves a name with no dot alone', () => {
    expect(stripFileExtension('Interview')).toBe('Interview')
  })

  it('leaves a name with a long "extension" (likely not an extension) alone', () => {
    expect(stripFileExtension('clip.v2.finalcut')).toBe('clip.v2.finalcut')
  })

  it('leaves a leading-dot dotfile-style name alone', () => {
    expect(stripFileExtension('.mp4')).toBe('.mp4')
  })

  it('handles multiple dots by only stripping the last short segment', () => {
    expect(stripFileExtension('My Trip 2024.10.mp4')).toBe('My Trip 2024.10')
  })
})
