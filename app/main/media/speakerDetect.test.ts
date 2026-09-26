import { describe, it, expect } from 'vitest'
import { estimateF0FromPcm, classifySpeaker } from './speakerDetect'

const SAMPLE_RATE = 16000

function sineWavePcm(frequencyHz: number, seconds: number, amplitude = 12000): Int16Array {
  const length = Math.round(SAMPLE_RATE * seconds)
  const samples = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE))
  }
  return samples
}

describe('estimateF0FromPcm', () => {
  it('estimates a low (male-range) pure tone within a few Hz', () => {
    const { f0Hz, voicedRatio } = estimateF0FromPcm(sineWavePcm(120, 1))
    expect(f0Hz).not.toBeNull()
    expect(f0Hz!).toBeGreaterThan(110)
    expect(f0Hz!).toBeLessThan(130)
    expect(voicedRatio).toBeGreaterThan(0.5)
  })

  it('estimates a high (female-range) pure tone within a few Hz', () => {
    const { f0Hz, voicedRatio } = estimateF0FromPcm(sineWavePcm(220, 1))
    expect(f0Hz).not.toBeNull()
    expect(f0Hz!).toBeGreaterThan(200)
    expect(f0Hz!).toBeLessThan(240)
    expect(voicedRatio).toBeGreaterThan(0.5)
  })

  it('reports no pitch at all for pure silence', () => {
    const { f0Hz, voicedRatio } = estimateF0FromPcm(new Int16Array(SAMPLE_RATE))
    expect(f0Hz).toBeNull()
    expect(voicedRatio).toBe(0)
  })
})

describe('classifySpeaker', () => {
  it('calls a clearly-low, well-voiced pitch male with high confidence', () => {
    const result = classifySpeaker(120, 0.9)
    expect(result.speaker).toBe('male')
    expect(result.confidence).toBeGreaterThan(0.7)
  })

  it('calls a clearly-high pitch female', () => {
    const result = classifySpeaker(220, 0.5)
    expect(result.speaker).toBe('female')
    expect(result.confidence).toBeGreaterThan(0.35)
  })

  it('falls back to unknown (no confidence) when there is no pitch estimate at all', () => {
    const result = classifySpeaker(null, 0)
    expect(result.speaker).toBe('unknown')
    expect(result.confidence).toBeUndefined()
  })

  it('falls back to unknown when the pitch sits right at the boundary with low voiced ratio', () => {
    const result = classifySpeaker(165, 0.2)
    expect(result.speaker).toBe('unknown')
    expect(result.confidence).toBeUndefined()
  })
})
