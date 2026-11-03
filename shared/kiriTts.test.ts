import { describe, expect, it } from 'vitest'
import { explainKiriError, isRetryableKiriStatus, kiriInstructions, kiriLeadInEnd, kiriLetterCount, kiriTakeMissesWords, kiriWithEndMark, kiriRetake, kiriTakeVerdict, kiriExpectedSeconds, kiriVoiceId, kiriVoiceOf, parseKiriVoices, KIRI_INSTRUCTIONS_MAX } from './kiriTts'
import { DUBBING_EMOTIONS, DUBBING_PACES, type LinePerformance } from './dubbingPerformance'

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
  it('asks for the delivery, not the name of the feeling (what KiriTTS follows)', () => {
    expect(kiriInstructions(perf({ emotion: 'angry', emotionIntensity: 85, speakingStyle: 'sharp, shouting' }))).toBe('Shouting furiously, enraged, loud and aggressive, yelling at someone')
    expect(kiriInstructions(perf({ emotion: 'angry', emotionIntensity: 25 }))).toBe('Annoyed, irritated, tense and clipped voice')
    expect(kiriInstructions(perf({ emotion: 'whisper' }))).toMatch(/^Whispering/)
  })
  it('adds the pace, and drops the slowness of a line asked to go faster', () => {
    expect(kiriInstructions(perf({ emotion: 'sad', pace: 'slow' }))).toBe('Very sad, soft, sorrowful, low voice, slow')
    expect(kiriInstructions(perf({ emotion: 'sad', pace: 'fast' }))).toBe('Very sad, soft, sorrowful, low voice, fast')
    expect(kiriInstructions(perf({ pace: 'very_fast' }))).toBe('very fast')
  })
  it('an inner thought is asked for quietly, the feeling only named', () => {
    expect(kiriInstructions(perf({ emotion: 'angry', emotionIntensity: 90 }), true)).toBe('Soft inner thought, quiet, angry')
    expect(kiriInstructions(perf({}), true)).toBe('Soft inner thought, quiet')
  })
  it('never over the 100-character limit, for any emotion, strength and pace', () => {
    for (const emotion of DUBBING_EMOTIONS) {
      for (const pace of DUBBING_PACES) {
        for (const emotionIntensity of [20, 60, 95]) {
          for (const inner of [false, true]) expect(kiriInstructions(perf({ emotion, pace, emotionIntensity }), inner).length).toBeLessThanOrEqual(KIRI_INSTRUCTIONS_MAX)
        }
      }
    }
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
    expect(kiriRetake(2.2, 2, angry)).toEqual({ instructions: 'Shouting furiously, enraged, loud and aggressive, yelling at someone, fast' })
    expect(kiriRetake(3, 2, angry)).toEqual({ instructions: 'Shouting furiously, enraged, loud and aggressive, yelling at someone, very fast' })
    expect(kiriRetake(2.2, 2, { ...plain, emotion: 'sad', pace: 'slow', speakingStyle: '' })).toEqual({ instructions: 'Very sad, slow, soft, sorrowful, low voice' })
    expect(kiriRetake(3, 2, { ...angry, pace: 'very_fast' })).toBeNull()
  })
  it('a thought keeps its quiet delivery', () => {
    expect(kiriRetake(2.4, 2, plain, true)).toEqual({ instructions: 'Soft inner thought, quiet, fast' })
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

describe('kiriLeadInEnd', () => {
  /** Loudness per 10 ms from "0-9" digits: 0 = the peak, each step 5 dB
   * quieter, 9 = silence -- the shape printed from the measured takes. */
  const levels = (shape: string): number[] => [...shape].map((d) => (d === '9' ? 0 : 10 ** ((-5 * Number(d)) / 20)))
  const speech = (hundredths: number): string => '1012'.repeat(Math.ceil(hundredths / 4)).slice(0, hundredths)

  it('finds where the words begin after the opening thump (measured takes)', () => {
    // Loud at once, gone by 0.18 s, silence, words from 0.50 s.
    expect(kiriLeadInEnd(levels('000000011123477799' + '9'.repeat(32) + speech(300)))).toBeCloseTo(0.46, 5)
    // The shortest silence measured (0.15 s).
    expect(kiriLeadInEnd(levels('111100011112235667' + '9'.repeat(15) + speech(200)))).toBeCloseTo(0.29, 5)
  })

  it('leaves a take that builds up like a voice or has no silence after its first sound', () => {
    expect(kiriLeadInEnd(levels('9998765' + speech(300)))).toBeUndefined()
    expect(kiriLeadInEnd(levels(speech(300)))).toBeUndefined()
  })

  it('leaves a take whose silence comes late (a pause after real words)', () => {
    expect(kiriLeadInEnd(levels(speech(60) + '9'.repeat(30) + speech(200)))).toBeUndefined()
  })

  it('leaves a take with nothing much after the silence, and a take too short to judge', () => {
    expect(kiriLeadInEnd(levels('0001234' + '9'.repeat(40) + speech(15)))).toBeUndefined()
    expect(kiriLeadInEnd(levels('00012349999'))).toBeUndefined()
  })
})

describe('kiriTakeMissesWords', () => {
  const usual = [15, 15.4, 16, 14.8, 15.6]

  it('flags a take far quicker than the voice speaks: the line reported, last word gone', () => {
    const letters = kiriLetterCount('ថ្ងៃដែលទទួលបានជ័យជម្នះទាំងស្រុង')
    expect(kiriTakeMissesWords(letters, 1.44, usual)).toBe(true)
  })

  it('leaves a take at the voice\'s own pace, however fast that voice is', () => {
    expect(kiriTakeMissesWords(31, 2, usual)).toBe(false)
    expect(kiriTakeMissesWords(31, 1.66, [18.7, 18.7, 18.7, 18.7, 18.7])).toBe(false)
  })

  it('does not judge a short line, or a voice not heard enough yet', () => {
    expect(kiriTakeMissesWords(8, 0.2, usual)).toBe(false)
    expect(kiriTakeMissesWords(31, 1.44, [15, 15])).toBe(false)
  })
})

describe('kiriWithEndMark', () => {
  it('closes a line that has no end mark, and leaves one that has', () => {
    expect(kiriWithEndMark(' ទាំងស្រុង ')).toBe('ទាំងស្រុង។')
    expect(kiriWithEndMark('ទាំងស្រុង!')).toBe('ទាំងស្រុង!')
  })
})
