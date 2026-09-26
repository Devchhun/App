import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }))

let geminiKey: string | null = 'test-gemini-key'
vi.mock('./geminiApiKeyStore', () => ({ getGeminiApiKey: vi.fn(async () => geminiKey) }))

/** Each call gets the prompt; the test decides the answer. */
type Answer = { text: string; finishReason?: string }
let answer: (prompt: string, callIndex: number) => Answer
const prompts: string[] = []
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.models = {
      generateContent: vi.fn(async (request: { contents: Array<{ parts: Array<{ text: string }> }> }) => {
        const prompt = request.contents[0].parts[0].text
        prompts.push(prompt)
        const { text, finishReason } = answer(prompt, prompts.length - 1)
        return { text, candidates: [{ finishReason: finishReason ?? 'STOP' }] }
      })
    }
  })
}))

const { buildGeminiTranslatePrompt, parseGeminiTranslations, translateSegmentsWithGemini, TRANSLATION_BATCH_SIZE } = await import('./geminiTranslationService')

const seg = (i: number): { segmentId: string; text: string } => ({ segmentId: `seg-${i}`, text: `line ${i}` })

/** Answers every key found in the prompt with "KM <source text>". */
function translateAll(prompt: string): Answer {
  const rows = prompt.split('LINES TO TRANSLATE (key<TAB>text):\n')[1].split('\n')
  return { text: JSON.stringify({ translations: rows.map((row) => { const [key, source] = row.split('\t'); return { key, text: `KM ${source}` } }) }) }
}

beforeEach(() => {
  geminiKey = 'test-gemini-key'
  prompts.length = 0
  answer = translateAll
})

describe('parseGeminiTranslations', () => {
  const batch = [seg(1), seg(2), seg(3)]

  it('maps short keys back onto the real segment ids', () => {
    const text = JSON.stringify({ translations: [{ key: 'L2', text: 'ពីរ' }, { key: 'L1', text: 'មួយ' }] })
    expect(parseGeminiTranslations(text, batch)).toEqual([{ segmentId: 'seg-2', translated: 'ពីរ' }, { segmentId: 'seg-1', translated: 'មួយ' }])
  })

  it('drops unknown keys, empty text and duplicates instead of guessing', () => {
    const text = JSON.stringify({ translations: [{ key: 'L9', text: 'x' }, { key: 'L1', text: '  ' }, { key: 'L3', text: 'បី' }, { key: 'L3', text: 'again' }] })
    expect(parseGeminiTranslations(text, batch)).toEqual([{ segmentId: 'seg-3', translated: 'បី' }])
  })

  it('returns nothing for an answer that is not JSON', () => {
    expect(parseGeminiTranslations('{"translations": [', batch)).toEqual([])
  })
})

describe('buildGeminiTranslatePrompt', () => {
  it('sends each line under a short key and asks for one entry per key', () => {
    const prompt = buildGeminiTranslatePrompt([seg(1), seg(2)], 'Khmer', [])
    expect(prompt).toContain('L1\tline 1\nL2\tline 2')
    expect(prompt).toContain('Never merge, split, skip, reorder, or add lines')
    expect(prompt).toContain('natural spoken Khmer')
  })

  it('includes earlier translations so names stay consistent', () => {
    const prompt = buildGeminiTranslatePrompt([seg(3)], 'Khmer', [{ source: 'Anna, wait!', translated: 'អាណា ចាំសិន!' }])
    expect(prompt).toContain('Anna, wait!  =>  អាណា ចាំសិន!')
  })
})

describe('translateSegmentsWithGemini', () => {
  it('translates a long SRT in batches and carries context between them', async () => {
    const segments = Array.from({ length: 130 }, (_, i) => seg(i + 1))
    const results = await translateSegmentsWithGemini(segments, 'Khmer', new AbortController().signal)
    expect(results).toHaveLength(130)
    expect(results[129]).toEqual({ segmentId: 'seg-130', translated: 'KM line 130' })
    expect(prompts).toHaveLength(Math.ceil(130 / TRANSLATION_BATCH_SIZE))
    // The second batch sees how the end of the first one was translated.
    expect(prompts[1]).toContain(`line ${TRANSLATION_BATCH_SIZE}  =>  KM line ${TRANSLATION_BATCH_SIZE}`)
  })

  it('asks once more for lines the model skipped', async () => {
    answer = (prompt, call) => {
      if (call > 0) return translateAll(prompt)
      return { text: JSON.stringify({ translations: [{ key: 'L1', text: 'KM line 1' }] }) }
    }
    const results = await translateSegmentsWithGemini([seg(1), seg(2), seg(3)], 'Khmer', new AbortController().signal)
    expect(results.map((r) => r.segmentId).sort()).toEqual(['seg-1', 'seg-2', 'seg-3'])
    // The retry only carries the two missing lines.
    expect(prompts[1]).toContain('L1\tline 2\nL2\tline 3')
  })

  it('splits a batch whose answer was cut off by the output limit', async () => {
    answer = (prompt) => {
      const rows = prompt.split('LINES TO TRANSLATE (key<TAB>text):\n')[1].split('\n')
      if (rows.length > 30) return { text: '{"translations": [', finishReason: 'MAX_TOKENS' }
      return translateAll(prompt)
    }
    const segments = Array.from({ length: 60 }, (_, i) => seg(i + 1))
    const results = await translateSegmentsWithGemini(segments, 'Khmer', new AbortController().signal)
    expect(results).toHaveLength(60)
    expect(new Set(results.map((r) => r.segmentId)).size).toBe(60)
  })

  it('explains a missing key instead of calling Gemini', async () => {
    geminiKey = null
    await expect(translateSegmentsWithGemini([seg(1)], 'Khmer', new AbortController().signal)).rejects.toThrow('Gemini API key is not configured')
    expect(prompts).toHaveLength(0)
  })
})
