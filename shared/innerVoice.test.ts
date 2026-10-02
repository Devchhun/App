import { describe, expect, it } from 'vitest'
import { analyzeEcho, ECHO_SCORE_THRESHOLD, effectiveInnerVoice, innerVoiceFromText } from './innerVoice'

const RATE = 8000

/** Speech-like test signal: syllables (noise bursts under a 5 Hz-ish
 * envelope) with short gaps, 1 s of room before and after. */
function syllables(options: { echo?: boolean; bed?: number } = {}): { samples: Float32Array; start: number; end: number } {
  const seconds = 4
  const out = new Float32Array(seconds * RATE)
  let seed = 7
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 1073741824 - 1
  }
  const start = 1
  const syllable = 0.16
  const gap = 0.09
  for (let k = 0; k < 7; k++) {
    const s0 = Math.round((start + k * (syllable + gap)) * RATE)
    for (let i = 0; i < syllable * RATE; i++) out[s0 + i] = 0.5 * Math.sin((Math.PI * i) / (syllable * RATE)) * noise()
  }
  const end = start + 7 * (syllable + gap)
  if (options.echo) {
    const dry = out.slice()
    for (const [delayMs, gain] of [[60, 0.5], [120, 0.3], [180, 0.15]] as const) {
      const d = Math.round((delayMs / 1000) * RATE)
      for (let i = d; i < out.length; i++) out[i] += dry[i - d] * gain
    }
  }
  if (options.bed) for (let i = 0; i < out.length; i++) out[i] += options.bed * noise()
  return { samples: out, start, end }
}

describe('inner voice from subtitle text', () => {
  it('reads a bracketed line or an inner-voice tag as a thought', () => {
    for (const t of ['（他到底想干什么）', '(ខ្ញុំត្រូវតែរត់)', 'OS: 我不能输', '内心：怎么办', '(គិតក្នុងចិត្ត) ខ្ញុំខ្លាច']) expect(innerVoiceFromText(t), t).toBe(true)
  })
  it('leaves spoken lines and narration alone', () => {
    for (const t of ['ថ្ងៃនេះ ខ្ញុំទៅផ្សារ', '旁白：很久以前', 'He said (quietly) no', '']) expect(innerVoiceFromText(t), t).toBe(false)
  })
})

describe('echo in the original audio', () => {
  it('passes a dry line, with or without a background', () => {
    for (const bed of [0, 0.01]) {
      const { samples, start, end } = syllables({ bed })
      expect(analyzeEcho(samples, RATE, start, end).score).toBeLessThan(ECHO_SCORE_THRESHOLD)
    }
  })
  it('flags the same line with an echo on it', () => {
    for (const bed of [0, 0.01]) {
      const { samples, start, end } = syllables({ echo: true, bed })
      expect(analyzeEcho(samples, RATE, start, end).score).toBeGreaterThanOrEqual(ECHO_SCORE_THRESHOLD)
    }
  })
  it('judges nothing when the background drowns the voice', () => {
    const { samples, start, end } = syllables({ echo: true, bed: 0.4 })
    expect(analyzeEcho(samples, RATE, start, end).score).toBe(0)
  })
})

describe('which lines are dubbed as an inner voice', () => {
  const spoken = { text: 'ខ្ញុំទៅផ្សារ' }
  it('counts Gemini, the text and a detection; a hand choice stands over all of them', () => {
    expect(effectiveInnerVoice(undefined, { ...spoken, innerVoice: true })).toBe(true)
    expect(effectiveInnerVoice(undefined, { text: '（怎么办）' })).toBe(true)
    expect(effectiveInnerVoice({ innerVoice: true, innerVoiceSource: 'echo' }, spoken)).toBe(true)
    expect(effectiveInnerVoice(undefined, spoken)).toBe(false)
    expect(effectiveInnerVoice({ innerVoice: false, innerVoiceSource: 'manual' }, { text: '（怎么办）', innerVoice: true })).toBe(false)
    expect(effectiveInnerVoice({ innerVoice: true, innerVoiceSource: 'manual' }, spoken)).toBe(true)
  })
})
