import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TranscriptSegment } from '@shared/transcription'
import type { ClassificationResult } from './providers/AiProvider'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

const classifySegmentsMock = vi.fn<
  (apiKey: string, segments: { segmentId: string; text: string }[], signal: AbortSignal) => Promise<ClassificationResult[]>
>()

vi.mock('./providers/AnthropicProvider', () => ({
  AnthropicProvider: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.name = 'anthropic'
    this.model = 'claude-sonnet-5'
    this.classifySegments = classifySegmentsMock
    this.simplifyText = vi.fn()
  })
}))

vi.mock('./apiKeyStore', () => ({
  getApiKey: vi.fn().mockResolvedValue('test-api-key')
}))

function makeSegment(id: string, text: string): TranscriptSegment {
  return { id, words: [], startTime: 0, endTime: 1, language: 'en', confidence: 0.9, text, needsReview: false }
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cae-service-test-'))
  classifySegmentsMock.mockReset()
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('buildCloudRequestPreview (consent)', () => {
  it('summarizes exactly what will be sent, without making any request', async () => {
    const { buildCloudRequestPreview } = await import('./suggestionsService')
    const segments = [makeSegment('a', 'Hello there'), makeSegment('b', 'General Kenobi')]
    const preview = buildCloudRequestPreview(segments)
    expect(preview.segmentCount).toBe(2)
    expect(preview.characterCount).toBe('Hello there\nGeneral Kenobi'.length)
    expect(preview.textPreview).toContain('Hello there')
    expect(preview.model).toBe('claude-sonnet-5')
    expect(classifySegmentsMock).not.toHaveBeenCalled()
  })
})

describe('generateSuggestions caching', () => {
  it('does not call the provider again on a second request when a valid cache result exists', async () => {
    classifySegmentsMock.mockResolvedValue([
      { segmentId: 'a', purpose: 'main_claim', visualText: 'Hi', reason: 'greeting', confidence: 0.9 }
    ])
    const { generateSuggestions } = await import('./suggestionsService')
    const segments = [makeSegment('a', 'Hello there')]

    const first = await generateSuggestions('req-1', 'media-1', segments, false)
    expect(first.fromCache).toBe(false)
    expect(classifySegmentsMock).toHaveBeenCalledTimes(1)

    const second = await generateSuggestions('req-2', 'media-1', segments, false)
    expect(second.fromCache).toBe(true)
    expect(classifySegmentsMock).toHaveBeenCalledTimes(1)
    expect(second.suggestions[0].visualText).toBe('Hi')
  })

  it('"Regenerate anyway" (forceRegenerate) bypasses a valid cache and calls the provider again', async () => {
    classifySegmentsMock.mockResolvedValue([
      { segmentId: 'a', purpose: 'main_claim', visualText: 'Hi', reason: 'greeting', confidence: 0.9 }
    ])
    const { generateSuggestions } = await import('./suggestionsService')
    const segments = [makeSegment('a', 'Hello there')]

    await generateSuggestions('req-1', 'media-1', segments, false)
    expect(classifySegmentsMock).toHaveBeenCalledTimes(1)

    const forced = await generateSuggestions('req-2', 'media-1', segments, true)
    expect(forced.fromCache).toBe(false)
    expect(classifySegmentsMock).toHaveBeenCalledTimes(2)
  })

  it('drops results that reference a segment id not present in the current transcript', async () => {
    classifySegmentsMock.mockResolvedValue([
      { segmentId: 'a', purpose: 'main_claim', visualText: 'Hi', reason: 'greeting', confidence: 0.9 },
      { segmentId: 'ghost', purpose: 'main_claim', visualText: 'Bad', reason: 'bad', confidence: 0.9 }
    ])
    const { generateSuggestions } = await import('./suggestionsService')
    const segments = [makeSegment('a', 'Hello there')]

    const result = await generateSuggestions('req-1', 'media-1', segments, false)
    expect(result.suggestions.map((s) => s.segmentId)).toEqual(['a'])
  })
})

describe('cancellation', () => {
  it('cancelRequest returns false for an unknown request id', async () => {
    const { cancelRequest } = await import('./suggestionsService')
    expect(cancelRequest('never-started')).toBe(false)
  })

  it('cancelRequest aborts the signal passed into the provider for an in-flight request', async () => {
    let capturedSignal: AbortSignal | undefined
    classifySegmentsMock.mockImplementation(
      (_apiKey, _segments, signal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const { generateSuggestions, cancelRequest } = await import('./suggestionsService')
    const segments = [makeSegment('a', 'Hello there')]

    const promise = generateSuggestions('req-cancel', 'media-1', segments, false)
    // requireApiKey() and the cache lookup both await first, so give those
    // microtasks/IO a chance to resolve before the provider call (and its
    // abort listener) is actually registered.
    for (let i = 0; i < 10 && !capturedSignal; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(cancelRequest('req-cancel')).toBe(true)

    await expect(promise).rejects.toThrow()
    expect(capturedSignal?.aborted).toBe(true)
  })
})
