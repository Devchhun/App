import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TranscriptSegment } from '@shared/transcription'
import { SCENE_PLAN_LIMITS, SCENE_PLAN_SCHEMA_VERSION, DEFAULT_SCENE_PLAN_OPTIONS } from '@shared/localAi'
import type { ScenePlanGenerationOptions } from '@shared/localAi'

const generateJsonMock = vi.fn()
const pullModelMock = vi.fn()
const checkHealthMock = vi.fn()

vi.mock('./providers/OllamaProvider', () => ({
  OllamaProvider: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.name = 'ollama'
    this.checkHealth = checkHealthMock
    this.listModels = vi.fn()
    this.pullModel = pullModelMock
    this.unloadModel = vi.fn()
    this.generateJson = generateJsonMock
  })
}))

function makeSegment(id: string, text: string, startTime = 0, endTime = 5): TranscriptSegment {
  return { id, words: [], startTime, endTime, language: 'en', confidence: 0.9, text, needsReview: false }
}

function validRawScene(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    segmentId: 'seg-1',
    startTime: 1,
    endTime: 3,
    purpose: 'introduction',
    templateId: 'lower-third',
    content: { title: 'Hi' },
    confidence: 0.8,
    explanation: 'because',
    ...overrides
  }
}

beforeEach(() => {
  generateJsonMock.mockReset()
  pullModelMock.mockReset()
  checkHealthMock.mockReset()
})

describe('generateScenePlan -- happy path', () => {
  it('returns a validated plan from a single-batch request', async () => {
    generateJsonMock.mockResolvedValue({ scenes: [validRawScene()] })
    const { generateScenePlan } = await import('./localAiService')
    const segments = [makeSegment('seg-1', 'Hello there', 0, 5)]
    const result = await generateScenePlan('req-1', 'media-1', segments, 60, 'qwen2.5:7b-instruct')
    expect(result.plan.scenes).toHaveLength(1)
    expect(result.plan.mediaId).toBe('media-1')
    expect(result.plan.version).toBe(SCENE_PLAN_SCHEMA_VERSION)
    expect(generateJsonMock).toHaveBeenCalledTimes(1)
  })

  it('returns an empty plan without calling the provider for zero segments', async () => {
    const { generateScenePlan } = await import('./localAiService')
    const result = await generateScenePlan('req-1', 'media-1', [], 60, 'qwen2.5:7b-instruct')
    expect(result.plan.scenes).toHaveLength(0)
    expect(generateJsonMock).not.toHaveBeenCalled()
  })
})

describe('generateScenePlan -- malformed / invalid model output', () => {
  it('gracefully handles a response with no scenes array at all', async () => {
    generateJsonMock.mockResolvedValue({ notScenes: 'oops' })
    const { generateScenePlan } = await import('./localAiService')
    const segments = [makeSegment('seg-1', 'Hello')]
    const result = await generateScenePlan('req-1', 'media-1', segments, 60, 'm')
    expect(result.plan.scenes).toHaveLength(0)
  })

  it('gracefully handles the provider returning a raw string instead of an object', async () => {
    generateJsonMock.mockResolvedValue('not an object')
    const { generateScenePlan } = await import('./localAiService')
    const segments = [makeSegment('seg-1', 'Hello')]
    const result = await generateScenePlan('req-1', 'media-1', segments, 60, 'm')
    expect(result.plan.scenes).toHaveLength(0)
  })

  it('drops individually-invalid scenes but keeps valid ones from the same response', async () => {
    generateJsonMock.mockResolvedValue({
      scenes: [validRawScene({ id: 'good' }), validRawScene({ id: 'bad', templateId: 'not-a-real-template' })]
    })
    const { generateScenePlan } = await import('./localAiService')
    const segments = [makeSegment('seg-1', 'Hello')]
    const result = await generateScenePlan('req-1', 'media-1', segments, 60, 'm')
    expect(result.plan.scenes.map((s) => s.id)).toEqual(['good'])
    expect(result.rejectedScenes).toHaveLength(1)
  })
})

describe('generateScenePlan -- provider errors propagate', () => {
  it('propagates a model-not-found error from the provider', async () => {
    const { LocalAiProviderError } = await import('./providers/LocalAiProvider')
    generateJsonMock.mockRejectedValue(new LocalAiProviderError('model-not-found', 'no such model'))
    const { generateScenePlan } = await import('./localAiService')
    const segments = [makeSegment('seg-1', 'Hello')]
    await expect(generateScenePlan('req-1', 'media-1', segments, 60, 'missing-model')).rejects.toMatchObject({ kind: 'model-not-found' })
  })
})

describe('generateScenePlan -- cancellation', () => {
  it('lets cancelRequest abort an in-flight generation', async () => {
    let capturedSignal: AbortSignal | undefined
    generateJsonMock.mockImplementation((_req: unknown, signal: AbortSignal) => {
      capturedSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const { generateScenePlan, cancelRequest } = await import('./localAiService')
    const segments = [makeSegment('seg-1', 'Hello')]
    const promise = generateScenePlan('req-cancel', 'media-1', segments, 60, 'm')
    // Give the request a tick to register itself before canceling.
    await new Promise((r) => setTimeout(r, 0))
    const canceled = cancelRequest('req-cancel')
    expect(canceled).toBe(true)
    expect(capturedSignal?.aborted).toBe(true)
    await expect(promise).rejects.toThrow()
  })

  it('cancelRequest returns false for an unknown/already-finished requestId', async () => {
    const { cancelRequest } = await import('./localAiService')
    expect(cancelRequest('never-existed')).toBe(false)
  })
})

describe('generateScenePlan -- batching (input length hard limit)', () => {
  it('splits a transcript exceeding the per-request char budget into multiple provider calls and merges results', async () => {
    const longText = 'x'.repeat(SCENE_PLAN_LIMITS.maxTranscriptCharsPerRequest - 100)
    const segments = [
      makeSegment('seg-1', longText, 0, 10),
      makeSegment('seg-2', longText, 10, 20) // pushes the second segment into a new batch
    ]
    generateJsonMock.mockImplementation((req: { userPrompt: string }) => {
      const segId = req.userPrompt.includes('[seg-1]') ? 'seg-1' : 'seg-2'
      return Promise.resolve({ scenes: [validRawScene({ id: `scene-${segId}`, segmentId: segId, startTime: 0, endTime: 2 })] })
    })
    const { generateScenePlan } = await import('./localAiService')
    const result = await generateScenePlan('req-batch', 'media-1', segments, 30, 'm')
    expect(generateJsonMock).toHaveBeenCalledTimes(2)
    expect(result.plan.scenes.map((s) => s.segmentId).sort()).toEqual(['seg-1', 'seg-2'])
  })

  it('rejects outright when the transcript exceeds the absolute input-length ceiling', async () => {
    const { LocalAiProviderError } = await import('./providers/LocalAiProvider')
    const hugeText = 'x'.repeat(SCENE_PLAN_LIMITS.maxTranscriptCharsPerRequest * 21)
    const segments = [makeSegment('seg-1', hugeText)]
    const { generateScenePlan } = await import('./localAiService')
    await expect(generateScenePlan('req-1', 'media-1', segments, 60, 'm')).rejects.toBeInstanceOf(LocalAiProviderError)
    await expect(generateScenePlan('req-1', 'media-1', segments, 60, 'm')).rejects.toMatchObject({ kind: 'input-too-large' })
    expect(generateJsonMock).not.toHaveBeenCalled()
  })

  it('rejects outright when the segment COUNT exceeds the hard limit, even if each segment is tiny', async () => {
    const { LocalAiProviderError } = await import('./providers/LocalAiProvider')
    const segments = Array.from({ length: SCENE_PLAN_LIMITS.maxSegmentCount + 1 }, (_, i) => makeSegment(`seg-${i}`, 'hi', i, i + 1))
    const { generateScenePlan } = await import('./localAiService')
    await expect(generateScenePlan('req-1', 'media-1', segments, 1000, 'm')).rejects.toBeInstanceOf(LocalAiProviderError)
    await expect(generateScenePlan('req-1', 'media-1', segments, 1000, 'm')).rejects.toMatchObject({ kind: 'input-too-large' })
    expect(generateJsonMock).not.toHaveBeenCalled()
  })

  it('accepts exactly the maximum segment count', async () => {
    generateJsonMock.mockResolvedValue({ scenes: [] })
    const segments = Array.from({ length: SCENE_PLAN_LIMITS.maxSegmentCount }, (_, i) => makeSegment(`seg-${i}`, 'hi', i, i + 1))
    const { generateScenePlan } = await import('./localAiService')
    const result = await generateScenePlan('req-1', 'media-1', segments, 1000, 'm')
    expect(result.plan.scenes).toEqual([])
  })
})

describe('generateScenePlan -- quality controls (creativity/density/preferredCategories/minConfidence/maxSimultaneousGraphics)', () => {
  const segments = [makeSegment('seg-1', 'hello world')]

  it('passes creativity through to the provider as a 0-1 temperature', async () => {
    generateJsonMock.mockResolvedValue({ scenes: [] })
    const { generateScenePlan } = await import('./localAiService')
    const options: ScenePlanGenerationOptions = { ...DEFAULT_SCENE_PLAN_OPTIONS, creativity: 80 }
    await generateScenePlan('req-1', 'media-1', segments, 60, 'm', options)
    expect(generateJsonMock).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.8 }), expect.anything())
  })

  it('reflects the requested density in the system prompt', async () => {
    generateJsonMock.mockResolvedValue({ scenes: [] })
    const { generateScenePlan } = await import('./localAiService')
    const minimal: ScenePlanGenerationOptions = { ...DEFAULT_SCENE_PLAN_OPTIONS, density: 'minimal' }
    await generateScenePlan('req-1', 'media-1', segments, 60, 'm', minimal)
    const minimalPrompt = generateJsonMock.mock.calls[0][0].systemPrompt as string

    generateJsonMock.mockClear()
    const rich: ScenePlanGenerationOptions = { ...DEFAULT_SCENE_PLAN_OPTIONS, density: 'rich' }
    await generateScenePlan('req-2', 'media-1', segments, 60, 'm', rich)
    const richPrompt = generateJsonMock.mock.calls[0][0].systemPrompt as string

    expect(minimalPrompt).not.toEqual(richPrompt)
    expect(minimalPrompt.toLowerCase()).toMatch(/sparing|essential/)
    expect(richPrompt.toLowerCase()).toMatch(/generous/)
  })

  it('narrows the generation JSON schema templateId enum to preferred categories', async () => {
    generateJsonMock.mockResolvedValue({ scenes: [] })
    const { generateScenePlan } = await import('./localAiService')
    const options: ScenePlanGenerationOptions = { ...DEFAULT_SCENE_PLAN_OPTIONS, preferredCategories: ['warnings'] }
    await generateScenePlan('req-1', 'media-1', segments, 60, 'm', options)
    const schema = JSON.stringify(generateJsonMock.mock.calls[0][0].jsonSchema)
    expect(schema).toContain('warning-alert')
    // 'title-card' belongs to the 'titles' category, not 'warnings'.
    expect(schema).not.toContain('title-card')
  })

  it('drops scenes below minConfidence and enforces maxSimultaneousGraphics deterministically after generation', async () => {
    generateJsonMock.mockResolvedValue({
      scenes: [
        validRawScene({ id: 'low-conf', confidence: 0.1, startTime: 0, endTime: 2 }),
        validRawScene({ id: 'kept-a', confidence: 0.9, startTime: 0, endTime: 3 }),
        validRawScene({ id: 'kept-b', confidence: 0.8, startTime: 1, endTime: 4 }),
        validRawScene({ id: 'over-cap', confidence: 0.5, startTime: 2, endTime: 5 })
      ]
    })
    const { generateScenePlan } = await import('./localAiService')
    const options: ScenePlanGenerationOptions = { ...DEFAULT_SCENE_PLAN_OPTIONS, minConfidence: 0.3, maxSimultaneousGraphics: 2 }
    const result = await generateScenePlan('req-1', 'media-1', segments, 60, 'm', options)
    expect(result.plan.scenes.map((s) => s.id).sort()).toEqual(['kept-a', 'kept-b'])
    expect(result.rejectedScenes.length).toBeGreaterThanOrEqual(2)
  })
})

describe('pullModel / getHealth passthroughs', () => {
  it('getHealth delegates to the provider', async () => {
    checkHealthMock.mockResolvedValue({ status: 'running', providerName: 'ollama' })
    const { getHealth } = await import('./localAiService')
    expect(await getHealth()).toEqual({ status: 'running', providerName: 'ollama' })
  })

  it('pullModel tracks the request for cancellation and forwards progress with the requestId attached', async () => {
    pullModelMock.mockImplementation((_model: string, onProgress: (p: unknown) => void) => {
      onProgress({ model: 'm', percent: 50, status: 'pulling' })
      return Promise.resolve()
    })
    const { pullModel } = await import('./localAiService')
    const updates: { requestId: string }[] = []
    await pullModel('pull-req-1', 'm', (p) => updates.push(p))
    expect(updates[0].requestId).toBe('pull-req-1')
  })
})
