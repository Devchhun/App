import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import type { TranscriptSegment } from '@shared/transcription'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('./geminiApiKeyStore', () => ({ getGeminiApiKey: vi.fn(async () => 'test-key') }))
vi.mock('../media/jobRunner', () => {
  class CanceledError extends Error {}
  return { runFfmpeg: vi.fn(async () => undefined), cancelJob: vi.fn(), CanceledError }
})

/** Scripted narration answers, in call order; the language-polish calls
 * (text only, no video part) always get an empty repair list. */
let narrationAnswers: Array<{ text: string; finishReason?: string }> = []
const narrationPrompts: string[] = []
vi.mock('@google/genai', () => ({
  FileState: { ACTIVE: 'ACTIVE', FAILED: 'FAILED' },
  GoogleGenAI: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.files = {
      upload: vi.fn(async () => ({ name: 'files/chunk' })),
      get: vi.fn(async () => ({ state: 'ACTIVE', uri: 'gs://chunk', mimeType: 'video/mp4' })),
      delete: vi.fn(async () => undefined)
    }
    this.models = {
      generateContent: vi.fn(async (request: { contents: Array<{ parts: Array<{ text?: string; fileData?: unknown }> }> }) => {
        const parts = request.contents[0].parts
        if (!parts.some((part) => part.fileData)) return { text: '{"repairs":[]}', candidates: [{ finishReason: 'STOP' }] }
        narrationPrompts.push(parts.find((part) => part.text)?.text ?? '')
        const next = narrationAnswers.shift() ?? { text: '{"scenes":[],"characterIdentities":[]}' }
        return { text: next.text, candidates: [{ finishReason: next.finishReason ?? 'STOP' }] }
      })
    }
  })
}))

const { extractCompleteArrayItems, generateVideoStoryNarration } = await import('./geminiVideoNarrationService')

const scene = (start: number, end: number, narration: string): Record<string, unknown> => ({
  startTime: start, endTime: end, dialogueSummary: 'd', visibleAction: 'a', khmerNarration: narration, confidence: 0.9
})
const complete = (...scenes: Array<Record<string, unknown>>): string => JSON.stringify({ scenes, characterIdentities: [] })

describe('extractCompleteArrayItems', () => {
  it('keeps every whole scene of an answer cut off mid-scene', () => {
    const cut = complete(scene(0, 5, 'មួយ'), scene(5, 10, 'ពីរ')).replace(/\]\s*,\s*"characterIdentities".*$/, '') + ',{"startTime":10,"endTime":14,"khmerNarr'
    expect(extractCompleteArrayItems(cut, 'scenes')).toHaveLength(2)
  })

  it('is not fooled by braces and quotes inside the text', () => {
    const text = '{"scenes":[{"khmerNarration":"he said \\"{wait}\\" and left","startTime":1}'
    expect(extractCompleteArrayItems(text, 'scenes')).toEqual([{ khmerNarration: 'he said "{wait}" and left', startTime: 1 }])
  })

  it('returns nothing when the key never appears', () => {
    expect(extractCompleteArrayItems('{"sce', 'scenes')).toEqual([])
  })
})

const segments: TranscriptSegment[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, words: [], startTime: i * 5, endTime: i * 5 + 4, language: 'en', confidence: 1, text: `line ${i}`, needsReview: false }))
const request = (jobId: string): Parameters<typeof generateVideoStoryNarration>[0] => ({ jobId, videoPath: 'C:\\video.mp4', videoDurationSeconds: 60, segments, characterContext: '' } as Parameters<typeof generateVideoStoryNarration>[0])

describe('a narration chunk whose answer did not finish', () => {
  beforeEach(() => {
    narrationAnswers = []
    narrationPrompts.length = 0
  })

  it('keeps the whole scenes and asks again only for the time after them', async () => {
    const cut = complete(scene(0, 10, 'មួយ'), scene(10, 20, 'ពីរ')).replace(/\]\s*,\s*"characterIdentities".*$/, '') + ',{"startTime":20,"endTime":2'
    narrationAnswers = [{ text: cut, finishReason: 'MAX_TOKENS' }, { text: complete(scene(20, 40, 'បី'), scene(40, 58, 'បួន')) }]
    const result = await generateVideoStoryNarration(request('rest'), () => undefined)
    expect(result.scenes.map((s) => s.khmerNarration)).toEqual(['មួយ', 'ពីរ', 'បី', 'បួន'])
    expect(narrationPrompts).toHaveLength(2)
    // The second request covers only what was missing: from 20 s on.
    expect(narrationPrompts[1]).toMatch(/inside 20\.000-/)
  })

  it('splits the chunk in two when nothing usable came back', async () => {
    narrationAnswers = [{ text: '{"scenes":[{"startT', finishReason: 'MAX_TOKENS' }, { text: complete(scene(0, 25, 'ក')) }, { text: complete(scene(30, 55, 'ខ')) }]
    const result = await generateVideoStoryNarration(request('split'), () => undefined)
    expect(result.scenes.map((s) => s.khmerNarration)).toEqual(['ក', 'ខ'])
    expect(narrationPrompts).toHaveLength(3)
  })

  it('names the reason when a short range still cannot be read', async () => {
    narrationAnswers = Array.from({ length: 10 }, () => ({ text: '', finishReason: 'RECITATION' }))
    await expect(generateVideoStoryNarration(request('fail'), () => undefined)).rejects.toThrow(/could not be read \(RECITATION/)
  })
})
