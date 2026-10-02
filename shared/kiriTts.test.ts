import { describe, expect, it } from 'vitest'
import { explainKiriError, isRetryableKiriStatus, kiriInstructions, kiriRetake, kiriTakeVerdict, kiriExpectedSeconds, kiriVoiceId, kiriVoiceOf, parseKiriVoices, KIRI_INSTRUCTIONS_MAX } from './kiriTts'
import type { LinePerformance } from './dubbingPerformance'

const perf = (patch: Partial<LinePerformance>): LinePerformance => ({
  emotion: 'neutral', emotionIntensity: 50, speakingStyle: '', pace: 'normal', energy: 'medium', delivery: '', pauseHints: [], emphasisWords: [], analysisSource: 'rules', ...patch
})

describe('KiriTTS voices', () => {
  it('reads the voice list the API returns (measured shape), clones first', () => {
    const voices = parseKiriVoices({
      object: 'list',
      data: [
        { voice_id: 'Nita', name: 'Nita', category: 'Standard', gender: 'female' },
        { voice_id: 'Lee Chhun', name: 'Lee Chhun', category: 'Cloned', gender: null },
        { name: 'no-id-but-name', category: 'Standard', gender: 'male' },
        { category: 'Standard' }
      ]
    })
    expect(voices).toEqual([
      { id: 'Lee Chhun', name: 'Lee Chhun', cloned: true, gender: 'unknown' },
      { id: 'Nita', name: 'Nita', cloned: false, gender: 'female' },
      { id: 'no-id-but-name', name: 'no-id-but-name', cloned: false, gender: 'male' }
    ])
    expect(parseKiriVoices(null)).toEqual([])
  })

  it('voice ids round-trip, Khmer names included', () => {
    expect(kiriVoiceOf(kiriVoiceId('សម្រាយរឿង'))).toBe('សម្រាយរឿង')
    expect(kiriVoiceOf('male-adult')).toBeUndefined()
  })
})

describe('kiriInstructions', () => {
  it('nothing for a plain neutral line', () => {
    expect(kiriInstructions(perf({}))).toBe('')
  })
  it('emotion with strength, pace and style', () => {
    expect(kiriInstructions(perf({ emotion: 'angry', emotionIntensity: 85, pace: 'fast', speakingStyle: 'sharp, shouting' }))).toBe('very angry, fast, sharp, shouting')
  })
  it('an inner thought is asked for quietly; never over the 100-character limit', () => {
    const text = kiriInstructions(perf({ emotion: 'sad', speakingStyle: 'x'.repeat(200) }), true)
    expect(text.startsWith('soft inner thought')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(KIRI_INSTRUCTIONS_MAX)
  })
})

describe('KiriTTS errors', () => {
  it('explains the plan error the server really sends', () => {
    expect(explainKiriError(403, '{"error":{"message":"Your plan does not include API access.","type":"permission_error"}}')).toMatch(/Starter plan/)
    expect(explainKiriError(401, '{"error":{"message":"Invalid credentials"}}')).toMatch(/API key/)
    expect(explainKiriError(429, '{"error":{"message":"Monthly credit limit exceeded"}}')).toMatch(/credits/)
  })
  it('retries rate limits and server errors only', () => {
    expect(isRetryableKiriStatus(429, 'Rate limit exceeded: 100 per 1 minute')).toBe(true)
    expect(isRetryableKiriStatus(429, 'Monthly credit limit exceeded')).toBe(false)
    expect(isRetryableKiriStatus(503, '')).toBe(true)
    expect(isRetryableKiriStatus(403, '')).toBe(false)
  })
})

describe('kiriRetake', () => {
  const plain: LinePerformance = { emotion: 'neutral', emotionIntensity: 30, speakingStyle: 'natural, conversational', pace: 'normal', energy: 'medium', delivery: '', pauseHints: [], emphasisWords: [], analysisSource: 'rules' }
  it('leaves a take that fits alone', () => {
    expect(kiriRetake(1.9, 1.98, plain)).toBeNull()
    expect(kiriRetake(2.0, 1.98, plain)).toBeNull()
  })
  it("asks a plain line again at KiriTTS's own speed, at most 1.2", () => {
    expect(kiriRetake(2.2, 2, plain)).toEqual({ speed: 1.1 })
    expect(kiriRetake(3.04, 1.98, plain)).toEqual({ speed: 1.2 })
  })
  it('keeps the acting of an emotional line and asks for a faster pace', () => {
    const angry: LinePerformance = { ...plain, emotion: 'angry', emotionIntensity: 80, pace: 'normal', speakingStyle: '' }
    expect(kiriRetake(2.2, 2, angry)).toEqual({ instructions: 'very angry, fast' })
    expect(kiriRetake(3, 2, angry)).toEqual({ instructions: 'very angry, very fast' })
    expect(kiriRetake(2.2, 2, { ...plain, emotion: 'sad', pace: 'slow', speakingStyle: '' })).toEqual({ instructions: 'slightly sad' })
    expect(kiriRetake(3, 2, { ...angry, pace: 'very_fast' })).toBeNull()
  })
  it('a thought keeps its quiet delivery', () => {
    expect(kiriRetake(2.4, 2, plain, true)).toEqual({ instructions: 'soft inner thought, quiet, fast, natural, conversational' })
  })
})

describe('kiriInstructions without repeats', () => {
  it('says the emotion once when the style words repeat it', () => {
    const excited: LinePerformance = { emotion: 'excited', emotionIntensity: 50, speakingStyle: 'excited, eager, bright', pace: 'normal', energy: 'high', delivery: '', pauseHints: [], emphasisWords: [], analysisSource: 'rules' }
    expect(kiriInstructions(excited)).toBe('excited, eager, bright')
    expect(kiriInstructions({ ...excited, emotionIntensity: 80 })).toBe('very excited, eager, bright')
  })
})

describe('kiriTakeVerdict', () => {
  it('keeps a take that fits its text', () => {
    expect(kiriTakeVerdict([{ start: 0.1, end: 2.2 }], kiriExpectedSeconds('ទោះខ្ញុំមានថ្ម លួធាន នៅក្នុងដៃ'))).toEqual({})
  })
  it('cuts the tail after the words of a short line (real take: speech, 1.2 s of silence, a burst)', () => {
    expect(kiriTakeVerdict([{ start: 0, end: 0.5 }, { start: 1.75, end: 2.0 }], kiriExpectedSeconds('ហើយ...'))).toEqual({ cutAt: 0.58 })
  })
  it('does not cut a pause that comes before the words have had their time', () => {
    const v = kiriTakeVerdict([{ start: 0, end: 0.3 }, { start: 0.9, end: 3.4 }, { start: 4.4, end: 5 }], 2.5)
    expect(v).toEqual({ cutAt: 3.48 })
  })
  it('asks again for babble with nothing to cut at, and caps it', () => {
    const v = kiriTakeVerdict([{ start: 0, end: 26.9 }], kiriExpectedSeconds('វ៉ាង លីន!'))
    expect(v.retry).toBe(true)
    expect(v.cutAt).toBeCloseTo(kiriExpectedSeconds('វ៉ាង លីន!') * 2.5 + 1, 6)
  })
  it('leaves a slow voice alone (a clone measured at 8.8 letters/s)', () => {
    expect(kiriTakeVerdict([{ start: 0, end: 1.6 }], kiriExpectedSeconds('ចំណងឈាម!'))).toEqual({})
  })
  it('cuts sound after a full second of silence on a take already too long (real take)', () => {
    expect(kiriTakeVerdict([{ start: 0, end: 1.24 }, { start: 2.53, end: 3.04 }], kiriExpectedSeconds('នរណាហ៊ានកាត់ទោសយើង?!'))).toEqual({ cutAt: 1.32 })
  })
  it('leaves two joined short lines with their pause alone', () => {
    expect(kiriTakeVerdict([{ start: 0, end: 0.39 }, { start: 1.43, end: 1.76 }], kiriExpectedSeconds('ប៉ី...។ ប៉ី...'))).toEqual({})
  })
  it('counts letters, not spaces or punctuation', () => {
    expect(kiriExpectedSeconds('ស៊ាវ.........')).toBe(kiriExpectedSeconds('ស៊ាវ'))
  })
})
