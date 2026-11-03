import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.', isPackaged: false } }))

import { looksLikeSubtitles, readingBand, type ScreenSubtitleLine } from './screenSubtitles'

const line = (start: number, confidence: number): ScreenSubtitleLine => ({ start, end: start + 1.5, text: 'A line of text', confidence, frames: 6 })

describe('readingBand', () => {
  it('reads half a band above and below the found one (a second line), and out to the sides', () => {
    // Measured: single lines at y 0.661-0.732; "Once I enter / Martial Arts
    // Academy" reaches both further up and further down.
    const read = readingBand({ x: 0.14, y: 0.661, w: 0.72, h: 0.071, score: 0.9 })
    expect(read.y).toBeCloseTo(0.6255, 4)
    expect(read.h).toBeCloseTo(0.142, 4)
    expect(read.x).toBeCloseTo(0.05, 4)
    expect(read.x + read.w).toBeCloseTo(0.95, 4)
  })

  it('stays inside the frame for a band at the very bottom', () => {
    const read = readingBand({ x: 0.02, y: 0.9, w: 0.97, h: 0.1, score: 0.5 })
    expect(read.y).toBeCloseTo(0.85, 4)
    expect(read.y + read.h).toBeLessThanOrEqual(1.0000001)
    expect(read.x).toBeCloseTo(0.02, 4)
    expect(read.x + read.w).toBeCloseTo(0.99, 4)
  })
})

describe('looksLikeSubtitles', () => {
  const lines = (n: number, confidence: number): ScreenSubtitleLine[] => Array.from({ length: n }, (_, i) => line(i * 2, confidence))

  it('takes a steady stream of confidently read lines', () => {
    expect(looksLikeSubtitles(lines(40, 0.95), 100)).toBe(true)
  })

  it('refuses a logo or sign read now and then', () => {
    expect(looksLikeSubtitles(lines(3, 0.99), 100)).toBe(false)
    expect(looksLikeSubtitles(lines(8, 0.99), 20 * 60)).toBe(false)
  })

  it('refuses text read with little certainty throughout (a script the reader does not know)', () => {
    expect(looksLikeSubtitles(lines(40, 0.62), 100)).toBe(false)
    // A few weak lines among good ones are still subtitles.
    expect(looksLikeSubtitles([...lines(30, 0.95), ...lines(8, 0.6)], 100)).toBe(true)
  })
})
