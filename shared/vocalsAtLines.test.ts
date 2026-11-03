import { describe, expect, it } from 'vitest'
import { mixSpeechFrames, speechRangesInFile, SPEECH_FADE_SECONDS } from './vocalRemoval'

const clipAt = (startTime: number, duration: number, sourceIn = 0, rate = 1): { startTime: number; duration: number; sourceIn: number; rate: number } => ({ startTime, duration, sourceIn, rate })

describe('speechRangesInFile', () => {
  it('pads a line and puts it in the file time of a clip that starts partway in', () => {
    const [range] = speechRangesInFile([clipAt(100, 50, 20)], [{ startTime: 110, endTime: 112 }])
    expect(range).toEqual({ start: 29.85, end: 32.3 })
  })

  it('follows the speed of a slowed clip', () => {
    const [range] = speechRangesInFile([clipAt(0, 20, 0, 0.5)], [{ startTime: 4, endTime: 6 }])
    expect(range).toEqual({ start: 1.85, end: 3.3 })
  })

  it('joins lines in a short pause and keeps a long pause open', () => {
    const ranges = speechRangesInFile([clipAt(0, 60)], [
      { startTime: 1, endTime: 2 },
      { startTime: 2.5, endTime: 3 },
      { startTime: 20, endTime: 21 }
    ])
    expect(ranges).toEqual([
      { start: 0.85, end: 3.3 },
      { start: 19.85, end: 21.3 }
    ])
  })

  it('counts a line over a cut on both sides, in each clip of the file', () => {
    // Two clips of one film: file 0-10 then file 50-60, joined on the Timeline.
    const ranges = speechRangesInFile([clipAt(0, 10, 0), clipAt(10, 10, 50)], [{ startTime: 9, endTime: 11 }])
    expect(ranges).toEqual([
      { start: 8.85, end: 10.3 },
      { start: 49.85, end: 51.3 }
    ])
  })

  it('leaves out lines over other videos, and stays inside the file', () => {
    expect(speechRangesInFile([clipAt(0, 10)], [{ startTime: 30, endTime: 31 }])).toEqual([])
    expect(speechRangesInFile([clipAt(0, 10)], [{ startTime: 0, endTime: 9.9 }], 10)).toEqual([{ start: 0, end: 10 }])
  })
})

describe('mixSpeechFrames', () => {
  const rate = 1000
  const seconds = 3
  const block = (value: number): Int16Array => new Int16Array(rate * seconds * 2).fill(value)

  it('keeps the original outside the lines and the voice-free sound over them, with a fade between', () => {
    const mixed = block(1000)
    mixSpeechFrames(mixed, block(-1000), 0, rate, [{ start: 1, end: 2 }])
    const at = (t: number): number => mixed[Math.round(t * rate) * 2]
    expect(at(0.5)).toBe(1000)
    expect(at(1.5)).toBe(-1000)
    expect(at(2.5)).toBe(1000)
    expect(at(1 - SPEECH_FADE_SECONDS / 2)).toBe(0)
    expect(mixed[Math.round(1.5 * rate) * 2 + 1]).toBe(-1000)
  })

  it('gives the same result in blocks as in one go', () => {
    const ranges = [
      { start: 0.5, end: 1 },
      { start: 2, end: 2.5 }
    ]
    const whole = block(500)
    mixSpeechFrames(whole, block(-500), 0, rate, ranges)
    const parts = block(500)
    const clean = block(-500)
    const cut = 1700
    const first = parts.subarray(0, cut * 2)
    const second = parts.subarray(cut * 2)
    const cursor = mixSpeechFrames(first, clean.subarray(0, cut * 2), 0, rate, ranges)
    mixSpeechFrames(second, clean.subarray(cut * 2), cut, rate, ranges, cursor)
    expect(Array.from(parts)).toEqual(Array.from(whole))
  })
})
