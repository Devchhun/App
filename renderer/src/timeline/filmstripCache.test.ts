import { describe, it, expect, beforeEach } from 'vitest'
import {
  frameCountForWidth,
  filmstripCacheKey,
  readFilmstripCache,
  writeFilmstripCache,
  clearFilmstripCache,
  filmstripCacheSize,
  FILMSTRIP_CACHE_LIMIT,
  captureOrder,
  frameForSlot,
  nextSlotToCapture
} from './filmstripCache'

beforeEach(() => clearFilmstripCache())

describe('frameCountForWidth', () => {
  it('scales with width, roughly one frame per 80px', () => {
    expect(frameCountForWidth(800)).toBe(10)
    expect(frameCountForWidth(1200)).toBe(15)
  })

  it('never drops below 4, so a short clip still reads as a filmstrip', () => {
    expect(frameCountForWidth(10)).toBe(4)
    expect(frameCountForWidth(0)).toBe(4)
  })

  it('caps out, so zooming a long clip way in cannot ask for hundreds of decodes', () => {
    expect(frameCountForWidth(1_000_000)).toBe(4000)
  })

  it('is stable across small width changes -- the whole point of keying on it', () => {
    // A trim/zoom nudge within the same ~80px bucket must not invalidate
    // the cache entry and force a re-extraction. (Crossing a bucket boundary
    // legitimately does change the count, and should: the strip is being cut
    // into a different number of frames.)
    expect(frameCountForWidth(484)).toBe(6)
    expect(frameCountForWidth(500)).toBe(6)
    expect(frameCountForWidth(519)).toBe(6)
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

describe('captureOrder', () => {
  it('reads every slot once, coarse to fine', () => {
    expect(captureOrder(9)).toEqual([0, 8, 4, 2, 6, 1, 3, 5, 7])
    const order = captureOrder(40)
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i))
    // After four reads the strip already spans its whole length.
    expect(order.slice(0, 4)).toEqual([0, 32, 16, 8])
  })

  it('handles the smallest strips', () => {
    expect(captureOrder(1)).toEqual([0])
    expect(captureOrder(4)).toEqual([0, 2, 1, 3])
  })
})

describe('frameForSlot', () => {
  it('shows its own frame, else the nearest read one, else the thumbnail', () => {
    const frames = ['a', null, null, 'd', null]
    expect(frameForSlot(frames, 0)).toBe('a')
    expect(frameForSlot(frames, 1)).toBe('a')
    expect(frameForSlot(frames, 2)).toBe('d')
    expect(frameForSlot(frames, 4)).toBe('d')
    expect(frameForSlot([null, null], 1, 'thumb')).toBe('thumb')
    expect(frameForSlot([null, null], 1)).toBeUndefined()
  })
})

describe('nextSlotToCapture', () => {
  it('reads only the slots on screen, coarse to fine', () => {
    const order = captureOrder(9) // 0, 8, 4, 2, 6, 1, 3, 5, 7
    expect(nextSlotToCapture(order, new Set(), { from: 5, to: 7 })).toBe(6)
    expect(nextSlotToCapture(order, new Set([6]), { from: 5, to: 7 })).toBe(5)
    // The rest wait until they scroll into view.
    expect(nextSlotToCapture(order, new Set([5, 6, 7]), { from: 5, to: 7 })).toBeNull()
  })
})
