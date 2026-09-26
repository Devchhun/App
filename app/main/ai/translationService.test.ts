import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TranscriptSegment } from '@shared/transcription'
import type { TranslationResult } from '@shared/translation'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

const translateSegmentsMock = vi.fn<
  (apiKey: string, segments: { segmentId: string; text: string }[], targetLanguage: string, signal: AbortSignal) => Promise<TranslationResult[]>
>()

vi.mock('./providers/AnthropicProvider', () => ({
  AnthropicProvider: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.name = 'anthropic'
    this.model = 'claude-sonnet-5'
    this.classifySegments = vi.fn()
    this.simplifyText = vi.fn()
    this.transformScript = vi.fn()
    this.translateSegments = translateSegmentsMock
  })
}))

vi.mock('./apiKeyStore', () => ({
  getApiKey: vi.fn().mockResolvedValue('test-api-key')
}))

// Whether a Gemini key is saved decides which service translates.
let geminiKeySaved = false
vi.mock('./geminiApiKeyStore', () => ({
  hasGeminiApiKey: vi.fn(async () => geminiKeySaved)
}))

const geminiTranslateMock = vi.fn<(segments: { segmentId: string; text: string }[], targetLanguage: string, signal: AbortSignal) => Promise<TranslationResult[]>>()
vi.mock('./geminiTranslationService', () => ({
  GEMINI_TRANSLATION_MODEL: 'gemini-2.5-flash',
  translateSegmentsWithGemini: (...args: Parameters<typeof geminiTranslateMock>) => geminiTranslateMock(...args)
}))

function makeSegment(id: string, text: string): TranscriptSegment {
  return { id, words: [], startTime: 0, endTime: 1, language: 'en', confidence: 0.9, text, needsReview: false }
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cae-translation-service-test-'))
  translateSegmentsMock.mockReset()
  geminiTranslateMock.mockReset()
  geminiKeySaved = false
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('buildTranslationPreview (consent)', () => {
  it('summarizes exactly what will be sent, without making any request', async () => {
    const { buildTranslationPreview } = await import('./translationService')
    const segments = [makeSegment('a', 'Hello there'), makeSegment('b', 'General Kenobi')]
    const preview = await buildTranslationPreview(segments)
    expect(preview.segmentCount).toBe(2)
    expect(preview.characterCount).toBe('Hello there\nGeneral Kenobi'.length)
    expect(preview.textPreview).toContain('Hello there')
    expect(preview.model).toBe('claude-sonnet-5')
    expect(translateSegmentsMock).not.toHaveBeenCalled()
  })

  it('names the Gemini model when a Gemini key will do the translating', async () => {
    geminiKeySaved = true
    const { buildTranslationPreview } = await import('./translationService')
    expect((await buildTranslationPreview([makeSegment('a', 'Hi')])).model).toBe('gemini-2.5-flash')
  })
})

describe('choosing the translation service', () => {
  it('uses Gemini when its key is saved, and never touches Claude', async () => {
    geminiKeySaved = true
    geminiTranslateMock.mockResolvedValue([{ segmentId: 'a', translated: 'សួស្តី' }])
    const { translateSubtitles } = await import('./translationService')

    const result = await translateSubtitles('req-g', [makeSegment('a', 'Hello')], 'Khmer')

    expect(result.translations).toEqual([{ segmentId: 'a', translated: 'សួស្តី' }])
    expect(geminiTranslateMock).toHaveBeenCalledWith([{ segmentId: 'a', text: 'Hello' }], 'Khmer', expect.any(AbortSignal))
    expect(translateSegmentsMock).not.toHaveBeenCalled()
  })

  it('falls back to Claude when no Gemini key is saved', async () => {
    translateSegmentsMock.mockResolvedValue([{ segmentId: 'a', translated: 'សួស្តី' }])
    const { translateSubtitles } = await import('./translationService')

    await translateSubtitles('req-c', [makeSegment('a', 'Hello')], 'Khmer')

    expect(translateSegmentsMock).toHaveBeenCalled()
    expect(geminiTranslateMock).not.toHaveBeenCalled()
  })
})

describe('translateSubtitles', () => {
  it('returns the provider\'s translations and passes the target language through', async () => {
    translateSegmentsMock.mockResolvedValue([{ segmentId: 'a', translated: 'សួស្តី' }])
    const { translateSubtitles } = await import('./translationService')
    const segments = [makeSegment('a', 'Hello')]

    const result = await translateSubtitles('req-1', segments, 'Khmer')

    expect(result.translations).toEqual([{ segmentId: 'a', translated: 'សួស្តី' }])
    expect(result.missingSegmentIds).toEqual([])
    expect(translateSegmentsMock).toHaveBeenCalledWith('test-api-key', [{ segmentId: 'a', text: 'Hello' }], 'Khmer', expect.any(AbortSignal))
  })

  it('reports segment ids the provider did not return a translation for', async () => {
    translateSegmentsMock.mockResolvedValue([{ segmentId: 'a', translated: 'ok' }])
    const { translateSubtitles } = await import('./translationService')
    const segments = [makeSegment('a', 'Hello'), makeSegment('b', 'World')]

    const result = await translateSubtitles('req-1', segments, 'Khmer')

    expect(result.missingSegmentIds).toEqual(['b'])
  })
})

describe('cancellation', () => {
  it('cancelTranslationRequest returns false for an unknown request id', async () => {
    const { cancelTranslationRequest } = await import('./translationService')
    expect(cancelTranslationRequest('never-started')).toBe(false)
  })

  it('cancelTranslationRequest aborts the signal passed into the provider for an in-flight request', async () => {
    let capturedSignal: AbortSignal | undefined
    translateSegmentsMock.mockImplementation(
      (_apiKey, _segments, _targetLanguage, signal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const { translateSubtitles, cancelTranslationRequest } = await import('./translationService')
    const segments = [makeSegment('a', 'Hello')]

    const promise = translateSubtitles('req-cancel', segments, 'Khmer')
    for (let i = 0; i < 10 && !capturedSignal; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(cancelTranslationRequest('req-cancel')).toBe(true)

    await expect(promise).rejects.toThrow()
    expect(capturedSignal?.aborted).toBe(true)
  })
})
