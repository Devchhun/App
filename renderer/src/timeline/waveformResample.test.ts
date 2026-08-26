import { describe, it, expect } from 'vitest'
import { computeWaveformBars } from './waveformResample'
import type { WaveformData } from '@shared/media'

function waveform(peaks: number[]): WaveformData {
  return { peaks, sampleRate: 8000, bucketCount: peaks.length / 2 }
}

describe('computeWaveformBars', () => {
  it('returns one bar per pixel of width', () => {
    // 4 buckets spread evenly across a 4-second file: [min,max] pairs.
    const w = waveform([0, 0.2, -0.5, 0.5, -0.1, 0.1, -0.9, 0.9])
    const bars = computeWaveformBars(w, 4, 0, 4, 8)
    expect(bars).toHaveLength(8)
  })

  it('zooming in (more pixels for the same duration) samples finer detail, not just stretched bars', () => {
    const w = waveform([0, 0.2, -0.5, 0.5, -0.1, 0.1, -0.9, 0.9])
    const zoomedOut = computeWaveformBars(w, 4, 0, 4, 4)
    const zoomedIn = computeWaveformBars(w, 4, 0, 4, 40)
    expect(zoomedOut).toHaveLength(4)
    expect(zoomedIn).toHaveLength(40)
    // The loudest bucket (index 3: -0.9/0.9) must show up as its own,
    // undiluted peak somewhere once there's a bar per bucket -- zoomed out,
    // each bar averages multiple buckets so this specific bucket doesn't
    // necessarily dominate any single bar the same way.
    expect(zoomedIn.some((b) => b.max === 0.9 && b.min === -0.9)).toBe(true)
  })

  it('only samples the [sourceIn, sourceIn+duration) window, not the whole file', () => {
    // 4 buckets over an 8-second file -- each bucket covers 2s.
    const w = waveform([0, 0.1, 0, 0.2, 0, 0.3, 0, 0.4])
    // A clip trimmed to just the last 2 seconds (bucket 3 only, max 0.4).
    const bars = computeWaveformBars(w, 8, 6, 2, 1)
    expect(bars).toEqual([{ min: 0, max: 0.4 }])
  })

  it('returns an empty array when there is no waveform data', () => {
    expect(computeWaveformBars(undefined, 10, 0, 10, 100)).toEqual([])
  })

  it('returns an empty array for a non-positive duration or width', () => {
    const w = waveform([0, 0.5])
    expect(computeWaveformBars(w, 10, 0, 0, 100)).toEqual([])
    expect(computeWaveformBars(w, 10, 0, 10, 0)).toEqual([])
  })
})
