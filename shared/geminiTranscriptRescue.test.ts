import { describe, expect, it } from 'vitest'
import { mapWithConcurrency, oneAtATime } from './geminiTranscript'
import { normalizeWavBase64, transcribeSpan, type SpanRequest, type SpanTools } from './geminiTranscriptRescue'

/** Tools whose Gemini gives `answers` in turn, then NO_SPEECH. */
function toolsWith(answers: { text: string; finishReason?: string }[], audible = true): SpanTools & { asked: SpanRequest[]; read: [number, number][] } {
  const asked: SpanRequest[] = []
  const read: [number, number][] = []
  return {
    asked,
    read,
    readAudio: async (start, end) => {
      read.push([start, end])
      return 'sound'
    },
    generate: async (request) => {
      asked.push(request)
      const next = answers.shift()
      return { text: next?.text ?? 'NO_SPEECH', finishReason: next?.finishReason ?? 'STOP' }
    },
    isAudible: () => audible,
    normalize: () => 'louder'
  }
}

const rows = (count: number, from = 1): string =>
  Array.from({ length: count }, (_, i) => `${(from + i * 5).toFixed(3)}\t${(from + i * 5 + 3).toFixed(3)}\tM\tline ${from + i}`).join('\n')

describe('transcribeSpan', () => {
  it('asks once when the answer is good', async () => {
    const tools = toolsWith([{ text: rows(10) }])
    const lines = await transcribeSpan(tools, 'zh', 100, 164)
    expect(lines).toHaveLength(10)
    expect(tools.asked).toHaveLength(1)
    expect(tools.asked[0].maxOutputTokens).toBe(6400)
  })

  it('does not believe NO_SPEECH from a part with sound: asks again at a standard loudness', async () => {
    const tools = toolsWith([{ text: 'NO_SPEECH' }, { text: rows(10) }])
    const lines = await transcribeSpan(tools, 'zh', 0, 64)
    expect(lines).toHaveLength(10)
    expect(tools.asked[1].audio).toBe('louder')
  })

  it('believes NO_SPEECH from a quiet part, without spending more requests', async () => {
    const tools = toolsWith([{ text: 'NO_SPEECH' }], false)
    expect(await transcribeSpan(tools, 'zh', 0, 64)).toEqual([])
    expect(tools.asked).toHaveLength(1)
  })

  it('falls back to SRT when the louder copy gives nothing', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nline a\n\n2\n00:00:10,000 --> 00:00:12,000\nline b\n\n3\n00:00:40,000 --> 00:00:42,000\nline c\n'
    // First ask, the louder copy, then the SRT ask.
    const tools = toolsWith([{ text: 'NO_SPEECH' }, { text: 'NO_SPEECH' }, { text: srt }])
    const lines = await transcribeSpan(tools, 'zh', 0, 64)
    expect(lines.map((l) => l.verbatimText)).toEqual(['line a', 'line b', 'line c'])
  })

  it('cuts an audible part with no answer in two, and places the second half', async () => {
    const tools = toolsWith([
      // The whole part: first ask, louder copy, the SRT ask.
      { text: 'NO_SPEECH' },
      { text: 'NO_SPEECH' },
      { text: 'NO_SPEECH' },
      { text: rows(3) },
      { text: rows(3) }
    ])
    const lines = await transcribeSpan(tools, 'zh', 0, 64)
    expect(lines).toHaveLength(6)
    expect(tools.read).toContainEqual([0, 32])
    expect(tools.read).toContainEqual([32, 64])
    expect(lines[3].startTime).toBeCloseTo(33)
  })

  it('splits a transcript that keeps overflowing, keeping every line', async () => {
    const long = rows(12)
    const tools = toolsWith([
      { text: long, finishReason: 'MAX_TOKENS' },
      { text: long, finishReason: 'MAX_TOKENS' },
      { text: rows(6) },
      { text: rows(6) }
    ])
    const lines = await transcribeSpan(tools, 'zh', 0, 64)
    expect(lines).toHaveLength(12)
    expect(tools.asked[1].temperature).toBe(0.5)
    expect(lines[6].startTime).toBeCloseTo(33)
  })

  it('takes the second try when only the first overflowed', async () => {
    const tools = toolsWith([{ text: rows(2), finishReason: 'MAX_TOKENS' }, { text: rows(10) }])
    expect(await transcribeSpan(tools, 'zh', 0, 64)).toHaveLength(10)
  })

  it('passes a limit or connection failure up to the caller', async () => {
    const tools = toolsWith([])
    tools.generate = async () => {
      throw new Error('limit reached')
    }
    await expect(transcribeSpan(tools, 'zh', 0, 64)).rejects.toThrow('limit reached')
  })
})

describe('normalizeWavBase64', () => {
  const wav = (samples: number[]): string => {
    const bytes = new Uint8Array(44 + samples.length * 2)
    const view = new DataView(bytes.buffer)
    const tag = (at: number, text: string): void => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
    tag(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    tag(8, 'WAVE')
    tag(12, 'fmt ')
    view.setUint32(16, 16, true)
    tag(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true))
    return btoa(String.fromCharCode(...bytes))
  }
  const samplesOf = (base64: string): number[] => {
    const binary = atob(base64)
    const out: number[] = []
    for (let i = 44; i + 1 < binary.length; i += 2) {
      const v = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8)
      out.push(v >= 0x8000 ? v - 0x10000 : v)
    }
    return out
  }

  it('brings quiet sound up to the standard level', () => {
    const out = samplesOf(normalizeWavBase64(wav([328, -328, 328, -328]))!)
    expect(out[0]).toBeGreaterThan(3200)
    expect(out[0]).toBeLessThan(3400)
    expect(out[1]).toBe(-out[0])
  })

  it('clips instead of wrapping around', () => {
    const out = samplesOf(normalizeWavBase64(wav([30000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1].map((v) => v)))!)
    expect(out[0]).toBeGreaterThan(0)
  })

  it('leaves silence and non-WAV alone', () => {
    expect(normalizeWavBase64(wav([0, 0, 0, 0]))).toBeNull()
    expect(normalizeWavBase64(btoa('not a wav file at all'))).toBeNull()
  })
})

describe('episodes side by side', () => {
  it('runs the shared step one at a time while the rest overlap', async () => {
    const turn = oneAtATime()
    let together = 0
    let mostTogether = 0
    let mostInStep = 0
    let inStep = 0
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2))
    await mapWithConcurrency(6, 3, async () => {
      together += 1
      mostTogether = Math.max(mostTogether, together)
      await pause()
      await turn(async () => {
        inStep += 1
        mostInStep = Math.max(mostInStep, inStep)
        await pause()
        inStep -= 1
      })
      together -= 1
    })
    expect(mostTogether).toBe(3)
    expect(mostInStep).toBe(1)
  })

  it('a failed turn does not block the next, and its error reaches its caller', async () => {
    const turn = oneAtATime()
    const failed = turn(async () => {
      throw new Error('export failed')
    })
    const next = turn(async () => 'exported')
    await expect(failed).rejects.toThrow('export failed')
    await expect(next).resolves.toBe('exported')
  })
})

describe('transcript and Khmer in one request', () => {
  it('asks for both and keeps the translation of each row', async () => {
    const tools = toolsWith([{ text: '1.000\t2.500\tM\t你好\tសួស្តី\n4.000\t6.000\tF\tWhere is he? | គាត់នៅឯណា?\n8.000\t9.000\tM\t走' }])
    const lines = await transcribeSpan(tools, 'zh', 0, 64, false, 'Khmer')
    expect(tools.asked[0].prompt).toContain('translate each one into Khmer')
    expect(tools.asked[0].prompt).toContain('<TAB>TRANSLATION')
    expect(tools.asked[0].maxOutputTokens).toBe(6400 * 3)
    expect(lines.map((l) => [l.verbatimText, l.translation])).toEqual([
      ['你好', 'សួស្តី'],
      ['Where is he?', 'គាត់នៅឯណា?'],
      ['走', undefined]
    ])
  })

  it('leaves the plain prompt and rows as they were', async () => {
    const tools = toolsWith([{ text: rows(10) }])
    const lines = await transcribeSpan(tools, 'zh', 0, 64)
    expect(tools.asked[0].prompt).not.toContain('TRANSLATION')
    expect(lines.every((l) => l.translation === undefined)).toBe(true)
  })
})

