import { describe, it, expect, beforeEach } from 'vitest'
import {
  frameCountForWidth,
  filmstripCacheKey,
  readFilmstripCache,
  writeFilmstripCache,
  clearFilmstripCache,
  filmstripCacheSize,
  FILMSTRIP_CACHE_LIMIT
} from './filmstripCache'

beforeEach(() => clearFilmstripCache())

describe('frameCountForWidth', () => {
  it('scales with width, roughly one frame per 100px', () => {
    expect(frameCountForWidth(500)).toBe(5)
    expect(frameCountForWidth(1200)).toBe(12)
  })

  it('never drops below 4, so a short clip still reads as a filmstrip', () => {
    expect(frameCountForWidth(10)).toBe(4)
    expect(frameCountForWidth(0)).toBe(4)
  })

  it('caps out, so zooming a long clip way in cannot ask for hundreds of decodes', () => {
    expect(frameCountForWidth(100_000)).toBe(40)
  })

  it('is stable across small width changes -- the whole point of keying on it', () => {
    // A trim/zoom nudge within the same ~100px bucket must not invalidate
    // the cache entry and force a re-extraction. (Crossing a bucket boundary
    // legitimately does change the count, and should: the strip is being cut
    // into a different number of frames.)
    expect(frameCountForWidth(610)).toBe(6)
    expect(frameCountForWidth(640)).toBe(6)
    expect(frameCountForWidth(649)).toBe(6)
  })
})

describe('filmstripCacheKey', () => {
  it('separates two trims of the same source file', () => {
    const a = filmstripCacheKey('file:///a.mp4', 0, 10, 6)
    const b = filmstripCacheKey('file:///a.mp4', 5, 10, 6)
    expect(a).not.toBe(b)
  })

  it('separates the same window sampled at different frame counts', () => {
    expect(filmstripCacheKey('file:///a.mp4', 0, 10, 6)).not.toBe(filmstripCacheKey('file:///a.mp4', 0, 10, 12))
  })

  it('separates different source files', () => {
    expect(filmstripCacheKey('file:///a.mp4', 0, 10, 6)).not.toBe(filmstripCacheKey('file:///b.mp4', 0, 10, 6))
  })

  it('matches for an identical window, so a remount re-uses the extraction', () => {
    expect(filmstripCacheKey('file:///a.mp4', 2.5, 10, 6)).toBe(filmstripCacheKey('file:///a.mp4', 2.5, 10, 6))
  })
})

describe('read/write', () => {
  it('round-trips an entry', () => {
    writeFilmstripCache('k', { frames: ['a', 'b'], complete: false })
    expect(readFilmstripCache('k')).toEqual({ frames: ['a', 'b'], complete: false })
  })

  it('returns undefined for a key never written', () => {
    expect(readFilmstripCache('nope')).toBeUndefined()
  })

  it('overwrites rather than duplicating, so progressive writes stay one entry', () => {
    writeFilmstripCache('k', { frames: ['a'], complete: false })
    writeFilmstripCache('k', { frames: ['a', 'b'], complete: true })
    expect(filmstripCacheSize()).toBe(1)
    expect(readFilmstripCache('k')).toEqual({ frames: ['a', 'b'], complete: true })
  })
})

describe('eviction', () => {
  it('stays bounded no matter how long the session runs', () => {
    for (let i = 0; i < FILMSTRIP_CACHE_LIMIT + 50; i++) {
      writeFilmstripCache(`k${i}`, { frames: ['f'], complete: true })
    }
    expect(filmstripCacheSize()).toBe(FILMSTRIP_CACHE_LIMIT)
  })

  it('evicts the least recently used, not the least recently written', () => {
    for (let i = 0; i < FILMSTRIP_CACHE_LIMIT; i++) {
      writeFilmstripCache(`k${i}`, { frames: ['f'], complete: true })
    }
    // Touch the oldest entry -- it must now outlive the next eviction.
    expect(readFilmstripCache('k0')).toBeDefined()
    writeFilmstripCache('fresh', { frames: ['f'], complete: true })

    expect(readFilmstripCache('k0')).toBeDefined()
    expect(readFilmstripCache('k1')).toBeUndefined()
  })
})
