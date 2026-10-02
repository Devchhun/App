import { describe, expect, it } from 'vitest'
import {
  VOICE_IDENTITY_LOCK,
  analyzeLineByRules,
  analyzePerformancesByRules,
  buildLineContexts,
  buildLineControl,
  emotionProfile,
  extractEmotionTags,
  lineLoudnessTargetLufs,
  neutralPerformance,
  punctuationOf,
  restrainedPerformance,
  samePerformance,
  sanitizePerformance,
  type LinePerformance,
  type PerformanceInputLine
} from './dubbingPerformance'

const line = (id: string, text: string, speaker = 'A', start = 0, end = 2): PerformanceInputLine => ({ id, text, speaker, startTime: start, endTime: end })
const perf = (emotion: LinePerformance['emotion'], intensity: number, extra: Partial<LinePerformance> = {}): LinePerformance => ({
  ...neutralPerformance('ai'),
  emotion,
  emotionIntensity: intensity,
  ...extra
})

describe('emotion tags are read before the text is cleaned', () => {
  it('maps the Khmer tags', () => {
    expect(extractEmotionTags('(យំ) ម៉ែ... កុំចោលកូន').emotions).toEqual(['crying'])
    expect(extractEmotionTags('ហាហា (សើច)').emotions).toEqual(['happy'])
    expect(extractEmotionTags('(ស្រែក) រត់ទៅ!').emotions).toEqual(['shout'])
    expect(extractEmotionTags('(ខ្សឹប) ស្ងាត់ៗ').emotions).toEqual(['whisper'])
    expect(extractEmotionTags('(ភ័យ) កុំ...').emotions).toEqual(['fear'])
    expect(extractEmotionTags('(ខឹង) ឯងកុហក!').emotions).toEqual(['angry'])
  })
  it('maps English and full-width tags and keeps the raw notes', () => {
    const tags = extractEmotionTags('[laughs] okay（whispering）fine')
    expect(tags.emotions).toEqual(['happy', 'whisper'])
    expect(tags.tags).toEqual(['laughs', 'whispering'])
    expect(extractEmotionTags('no tags here').emotions).toEqual([])
  })
})

describe('context builder', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t, i) => line(`L${i}`, t, i % 2 ? 'B' : 'A', i * 2, i * 2 + 1.5))
  it('gives every line the 3 lines before and after it, and the speakers around it', () => {
    const ctx = buildLineContexts(lines)
    expect(ctx[4].previous.map((n) => n.text)).toEqual(['b', 'c', 'd'])
    expect(ctx[4].next.map((n) => n.text)).toEqual(['f', 'g', 'h'])
    expect(ctx[4].speaker).toBe('A')
    expect(ctx[4].previousSpeaker).toBe('B')
    expect(ctx[4].nextSpeaker).toBe('B')
    expect(ctx[4].durationSeconds).toBe(1.5)
    expect(ctx[0].previous).toEqual([])
    expect(ctx[7].next).toEqual([])
  })
  it('reads end punctuation', () => {
    expect(punctuationOf('អ្វី?!')).toBe('?!')
    expect(punctuationOf('Run!!!')).toBe('!')
    expect(punctuationOf('ម៉ែ...')).toBe('…')
    expect(punctuationOf('why?')).toBe('?')
    expect(punctuationOf('ok (laughs)')).toBe('')
  })
})

describe('local analyzer: six kinds of line', () => {
  const analyze = (text: string, neighbours: string[] = []): LinePerformance => {
    const lines = [...neighbours.map((t, i) => line(`n${i}`, t)), line('x', text)]
    return analyzeLineByRules(buildLineContexts(lines)[lines.length - 1])
  }
  it('1. a neutral conversation line stays neutral', () => {
    expect(analyze('ថ្ងៃនេះ ខ្ញុំនឹងទៅផ្សារជាមួយម្ដាយ។').emotion).toBe('neutral')
  })
  it('2. an exclamation inside a heated exchange is angry', () => {
    const p = analyze('ឯងកុហកខ្ញុំម្ដងទៀតហើយ!', ['(ខឹង) ចេញទៅ!'])
    expect(p.emotion).toBe('angry')
    expect(p.emotionIntensity).toBeGreaterThanOrEqual(60)
  })
  it('3. a (យំ) line is crying', () => {
    const p = analyze('(យំ) ម៉ែ... កុំចោលកូនទៅណា')
    expect(p.emotion).toBe('crying')
    expect(p.pace).toBe('slow')
  })
  it('4. "?!" is shocked', () => {
    expect(analyze('អ្វី?! អ្នកនៅរស់?!').emotion).toBe('shocked')
  })
  it('5. a (ខ្សឹប) line is a whisper', () => {
    const p = analyze('(ខ្សឹប) ស្ងាត់ៗ កុំឲ្យគេឮ')
    expect(p.emotion).toBe('whisper')
    expect(p.energy).toBe('low')
  })
  it('6. a (ស្រែក) line, or a line of exclamations, is a shout', () => {
    expect(analyze('(ស្រែក) រត់ទៅ!').emotion).toBe('shout')
    expect(analyze('Run! Run now!!').emotion).toBe('shout')
  })
  it('keeps emotion continuous: a plain line inside a crying scene of one speaker stays sad-ish', () => {
    const out = analyzePerformancesByRules([line('1', '(យំ) ម៉ែ...'), line('2', 'កូនមិនដឹងទេ'), line('3', '(យំ) កូនសុំទោស')])
    expect(out['2'].emotion).toBe('crying')
    expect(out['2'].emotionIntensity).toBeLessThan(out['1'].emotionIntensity)
  })
})

describe('per-line control (the prompt VoxCPM2 receives)', () => {
  const shocked: LinePerformance = {
    emotion: 'shocked',
    emotionIntensity: 78,
    speakingStyle: 'breathy, stunned, hesitant',
    pace: 'slow',
    energy: 'medium',
    delivery: 'start softly, slight trembling, become more urgent near the end',
    pauseHints: [{ after: 'មិនជឿ', duration: 'short' }],
    emphasisWords: ['អ្នក', 'នៅរស់'],
    analysisSource: 'ai'
  }
  it('has no "Do not perform dialogue" and keeps the identity lock', () => {
    const control = buildLineControl('adult male Cambodian Khmer voice, deep', shocked)
    expect(control).not.toMatch(/perform dialogue/i)
    expect(control).not.toMatch(/STRICT VOICE LOCK/)
    expect(control.startsWith(VOICE_IDENTITY_LOCK)).toBe(true)
    expect(control).toContain('Voice: adult male Cambodian Khmer voice, deep.')
  })
  it('carries the line\'s own performance', () => {
    const control = buildLineControl(undefined, shocked)
    for (const part of ['emotion shocked', 'intensity 78/100', 'Style: breathy, stunned, hesitant', 'Pace: slow', 'Energy: medium', 'Delivery: start softly', 'after "មិនជឿ"', '"អ្នក", "នៅរស់"', 'Do not sound like reading a script']) {
      expect(control).toContain(part)
    }
  })
  it('differs between lines: an angry line and a whisper get different controls', () => {
    expect(buildLineControl('x', perf('angry', 85))).not.toBe(buildLineControl('x', perf('whisper', 70)))
  })
  it('is one line with no parentheses (VoxCPM2 reads "(control)text")', () => {
    const control = buildLineControl('voice (deep)', { ...shocked, customPrompt: 'end in a (half) gasp' })
    expect(control).not.toMatch(/[()\n]/)
    expect(control).toContain('end in a half gasp.')
  })
})

describe('emotion profiles (what the runner accepts)', () => {
  it('neutral keeps the old pitch tolerance and correction', () => {
    const p = emotionProfile(perf('neutral', 30))
    expect(p.pitchToleranceSemitones).toBe(2)
    expect(p.pitchCorrect).toBe(true)
    expect(p.flatCheck).toBe(false)
  })
  it('angry and shout get more pitch room than neutral, but never unlimited (the voice comes first)', () => {
    for (const emotion of ['angry', 'shout', 'excited'] as const) {
      const p = emotionProfile(perf(emotion, 85))
      expect(p.pitchToleranceSemitones).toBeGreaterThan(2)
      expect(p.pitchToleranceSemitones).toBeLessThanOrEqual(4.5)
      expect(p.pitchCorrect).toBe(false)
      expect(p.expression).toBe('raise')
      expect(p.flatCheck).toBe(true)
      // An acted take is never asked to go beyond the voice's limit.
      expect(p.targetRaiseSt!).toBeLessThan(p.pitchToleranceSemitones!)
    }
  })
  it('keeps the similarity floor near neutral for every emotion', () => {
    for (const emotion of ['angry', 'shout', 'crying', 'fear', 'shocked', 'whisper', 'sad', 'happy'] as const) {
      expect(emotionProfile(perf(emotion, 85)).similarityFloor).toBeGreaterThanOrEqual(0.78)
      expect(emotionProfile(perf(emotion, 85)).consistencyFloor).toBe(0.74)
    }
  })
  it('sad, crying and fear get a little more room, still limited', () => {
    expect(emotionProfile(perf('sad', 60)).pitchToleranceSemitones).toBe(3)
    expect(emotionProfile(perf('crying', 80)).pitchToleranceSemitones).toBe(3.5)
    expect(emotionProfile(perf('fear', 80)).pitchToleranceSemitones).toBe(3.5)
  })
  it('Voice tone "Locked" gives every emotion less room and stricter identity', () => {
    const open = emotionProfile(perf('angry', 85))
    const locked = emotionProfile(perf('angry', 85), { voiceLock: true })
    expect(locked.pitchToleranceSemitones!).toBeLessThan(open.pitchToleranceSemitones!)
    expect(locked.pitchToleranceSemitones!).toBeGreaterThanOrEqual(2)
    expect(locked.similarityFloor).toBeGreaterThan(open.similarityFloor)
    expect(locked.targetRaiseSt!).toBeLessThan(locked.pitchToleranceSemitones!)
    expect(emotionProfile(perf('neutral', 30), { voiceLock: true }).pitchToleranceSemitones).toBe(2)
  })
  it('the held-back performance for the safe take keeps the emotion, lowers everything else', () => {
    const safe = restrainedPerformance({ ...perf('shout', 95), delivery: 'full voice', customPrompt: 'scream it', pauseHints: [{ after: 'x', duration: 'long' }] })
    expect(safe.emotion).toBe('shout')
    expect(safe.emotionIntensity).toBe(40)
    expect(safe.delivery).toBe('')
    expect(safe.customPrompt).toBeUndefined()
    expect(safe.pauseHints).toEqual([])
    expect(safe.speakingStyle.startsWith('restrained')).toBe(true)
  })
  it('a whisper is not judged on voiced pitch', () => {
    const p = emotionProfile(perf('whisper', 75))
    expect(p.usePitch).toBe(false)
    expect(p.expression).toBe('whisper')
  })
  it('only strongly-acted lines are checked for flatness, and the bar grows with intensity', () => {
    expect(emotionProfile(perf('angry', 40)).flatCheck).toBe(false)
    expect(emotionProfile(perf('calm', 90)).flatCheck).toBe(false)
    expect(emotionProfile(perf('angry', 95)).targetRaiseSt!).toBeGreaterThan(emotionProfile(perf('angry', 60)).targetRaiseSt!)
  })
  it('a line without a performance behaves as before (neutral)', () => {
    expect(emotionProfile(undefined).pitchToleranceSemitones).toBe(2)
  })
})

describe('loudness per emotion', () => {
  it('orders whisper < sad < neutral < angry < shout', () => {
    const whisper = lineLoudnessTargetLufs(perf('whisper', 75))
    const sad = lineLoudnessTargetLufs(perf('sad', 60))
    const neutral = lineLoudnessTargetLufs(perf('neutral', 30))
    const angry = lineLoudnessTargetLufs(perf('angry', 80))
    const shout = lineLoudnessTargetLufs(perf('shout', 90))
    expect(whisper).toBeLessThan(sad)
    expect(sad).toBeLessThan(neutral)
    expect(neutral).toBe(-18)
    expect(angry).toBeGreaterThan(neutral)
    expect(shout).toBeGreaterThan(angry)
    // Heard apart, but never the 13 dB swing one episode measured.
    expect(shout - whisper).toBeGreaterThanOrEqual(5)
    expect(shout - whisper).toBeLessThanOrEqual(8)
  })
  it('keeps the standard level for lines without a performance', () => {
    expect(lineLoudnessTargetLufs(undefined)).toBe(-18)
  })
})

describe('take joining and sanitizing', () => {
  it('only joins lines acted the same way', () => {
    expect(samePerformance(perf('angry', 80), perf('angry', 70))).toBe(true)
    expect(samePerformance(perf('angry', 80), perf('calm', 30))).toBe(false)
    expect(samePerformance(perf('angry', 90), perf('angry', 50))).toBe(false)
    expect(samePerformance(undefined, undefined)).toBe(true)
    expect(samePerformance(perf('neutral', 30), undefined)).toBe(false)
  })
  it('repairs bad values instead of failing the line', () => {
    const p = sanitizePerformance({ emotion: 'furious', emotionIntensity: 400, pace: 'warp', energy: 'x', pauseHints: [{ after: '' }, { after: 'ok', duration: 'long' }], emphasisWords: [1, 'a'] }, 'ai')!
    expect(p.emotion).toBe('neutral')
    expect(p.emotionIntensity).toBe(100)
    expect(p.pace).toBe('normal')
    expect(p.energy).toBe('medium')
    expect(p.pauseHints).toEqual([{ after: 'ok', duration: 'long' }])
    expect(p.emphasisWords).toEqual(['a'])
    expect(sanitizePerformance(null)).toBeNull()
    expect(sanitizePerformance({ text: 'no emotion' })).toBeNull()
  })
  it('keeps the source it is given (manual override)', () => {
    expect(sanitizePerformance(perf('angry', 50), 'manual')!.analysisSource).toBe('manual')
  })
})
