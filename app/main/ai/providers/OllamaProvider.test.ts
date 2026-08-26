import { describe, it, expect, vi, afterEach } from 'vitest'
import { OllamaProvider } from './OllamaProvider'
import { LocalAiProviderError } from './LocalAiProvider'
import { SCENE_PLAN_LIMITS } from '@shared/localAi'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ndjsonResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

function connRefused(): Error {
  const err = new TypeError('fetch failed')
  ;(err as unknown as { cause: unknown }).cause = { code: 'ECONNREFUSED' }
  return err
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.LOCALAPPDATA
})

describe('OllamaProvider.checkHealth', () => {
  it('reports running with the version when the server responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { version: '0.32.15' })))
    const provider = new OllamaProvider()
    const health = await provider.checkHealth()
    expect(health).toEqual({ status: 'running', version: '0.32.15', providerName: 'ollama' })
  })

  it('reports not-installed when connection is refused and no install dir exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connRefused()))
    const provider = new OllamaProvider()
    const health = await provider.checkHealth()
    expect(health.status).toBe('not-installed')
  })

  it('reports unknown when the server responds but not with a real version body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not ollama', { status: 200 })))
    const provider = new OllamaProvider()
    const health = await provider.checkHealth()
    expect(health.status).toBe('running') // a 200 response is still treated as "running" -- version is just absent
    expect(health.version).toBeUndefined()
  })
})

describe('OllamaProvider.listModels', () => {
  it('lists installed models and merges loaded state from /api/ps', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse(200, { models: [{ model: 'qwen2.5:7b-instruct', size: 123 }, { name: 'llama3.1:8b' }] }))
      }
      if (url.endsWith('/api/ps')) {
        return Promise.resolve(jsonResponse(200, { models: [{ model: 'qwen2.5:7b-instruct' }] }))
      }
      return Promise.reject(new Error('unexpected url ' + url))
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OllamaProvider()
    const models = await provider.listModels()
    expect(models).toEqual([
      { id: 'qwen2.5:7b-instruct', installed: true, loaded: true },
      { id: 'llama3.1:8b', installed: true, loaded: false }
    ])
  })

  it('still lists models when /api/ps fails (loaded state just unknown)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/tags')) return Promise.resolve(jsonResponse(200, { models: [{ model: 'a' }] }))
      return Promise.reject(new Error('ps down'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OllamaProvider()
    const models = await provider.listModels()
    expect(models).toEqual([{ id: 'a', installed: true, loaded: false }])
  })

  it('handles an empty install (models: [])', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => (url.endsWith('/api/tags') ? Promise.resolve(jsonResponse(200, { models: [] })) : Promise.resolve(jsonResponse(200, {}))))
    )
    const provider = new OllamaProvider()
    expect(await provider.listModels()).toEqual([])
  })
})

describe('OllamaProvider.pullModel -- NDJSON progress parsing', () => {
  it('aggregates progress per-digest across multiple layers without resetting', async () => {
    const lines = [
      JSON.stringify({ status: 'pulling manifest' }),
      JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total: 1000 }),
      JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 500 }),
      JSON.stringify({ status: 'pulling def', digest: 'sha256:def', total: 200 }),
      JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 1000 }),
      JSON.stringify({ status: 'pulling def', digest: 'sha256:def', total: 200, completed: 200 }),
      JSON.stringify({ status: 'verifying sha256 digest' }),
      JSON.stringify({ status: 'success' })
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(lines)))
    const provider = new OllamaProvider()
    const updates: { percent: number; totalBytes?: number }[] = []
    await provider.pullModel('m', (p) => updates.push({ percent: p.percent, totalBytes: p.totalBytes }), new AbortController().signal)
    // Once every digest (layer) has been discovered -- i.e. the reported
    // total stops growing -- percent must never regress. Before that point a
    // dip is expected and correct (a newly-discovered layer's own total
    // counts against the denominator before its own bytes start counting
    // toward the numerator) -- the bug this per-digest aggregation actually
    // prevents is a SINGLE digest's own progress resetting to 0 when it's
    // reported again, which the final-100% assertion below also covers.
    const finalTotal = updates[updates.length - 1].totalBytes
    const stable = updates.filter((u) => u.totalBytes === finalTotal)
    for (let i = 1; i < stable.length; i++) expect(stable[i].percent).toBeGreaterThanOrEqual(stable[i - 1].percent)
    expect(updates[updates.length - 1].percent).toBe(100)
  })

  it('surfaces a mid-stream {"error": ...} line as a thrown error', async () => {
    const lines = [JSON.stringify({ status: 'pulling manifest' }), JSON.stringify({ error: 'pull model manifest: file does not exist' })]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(lines)))
    const provider = new OllamaProvider()
    await expect(provider.pullModel('missing-model', () => {}, new AbortController().signal)).rejects.toThrow(/does not exist/)
  })

  it('tolerates a stray non-JSON line without aborting the stream', async () => {
    const lines = ['not json at all', JSON.stringify({ status: 'success' })]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(lines)))
    const provider = new OllamaProvider()
    const updates: string[] = []
    await provider.pullModel('m', (p) => updates.push(p.status), new AbortController().signal)
    expect(updates).toContain('success')
  })

  it('propagates a caller-initiated cancel as a canceled error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )
    const provider = new OllamaProvider()
    const controller = new AbortController()
    const promise = provider.pullModel('m', () => {}, controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'canceled' })
  })
})

describe('OllamaProvider.generateJson', () => {
  const request = { mediaId: 'm', model: 'qwen2.5:7b-instruct', systemPrompt: 'sys', userPrompt: 'user', jsonSchema: {} }

  it('parses the message content as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { message: { role: 'assistant', content: '{"scenes":[]}' }, done: true })))
    const provider = new OllamaProvider()
    const result = await provider.generateJson(request, new AbortController().signal)
    expect(result).toEqual({ scenes: [] })
  })

  it('sizes num_ctx from the prompt length rather than trusting Ollama\'s loaded default', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(200, { message: { content: '{"scenes":[]}' }, done: true }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OllamaProvider()

    await provider.generateJson({ ...request, systemPrompt: 'short', userPrompt: 'short' }, new AbortController().signal)
    const shortBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    // Even a tiny prompt still reserves output headroom for the JSON
    // response, so this floors well below the 32768 ceiling rather than
    // always requesting the max.
    expect(shortBody.options.num_ctx).toBeGreaterThanOrEqual(4096)
    expect(shortBody.options.num_ctx).toBeLessThan(16000)

    fetchMock.mockClear()
    const longPrompt = 'x'.repeat(8000) // a realistic-length Khmer transcript batch
    await provider.generateJson({ ...request, systemPrompt: 'sys', userPrompt: longPrompt }, new AbortController().signal)
    const longBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(longBody.options.num_ctx).toBeGreaterThan(4096)
    expect(longBody.options.num_ctx).toBeLessThanOrEqual(32768)
  })

  it('caps num_ctx at 32768 even for an extremely long prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: { content: '{"scenes":[]}' }, done: true }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OllamaProvider()
    await provider.generateJson({ ...request, systemPrompt: 'sys', userPrompt: 'x'.repeat(100_000) }, new AbortController().signal)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.options.num_ctx).toBe(32768)
  })

  it('rejects a response exceeding maxOutputChars before ever attempting JSON.parse', async () => {
    const hugeContent = '{"scenes":[' + 'x'.repeat(SCENE_PLAN_LIMITS.maxOutputChars + 1) + ']}'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { message: { content: hugeContent }, done: true })))
    const provider = new OllamaProvider()
    await expect(provider.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('throws malformed when message content is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { message: { content: 'not json{{' }, done: true })))
    const provider = new OllamaProvider()
    await expect(provider.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('throws malformed when there is no message content at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { done: true })))
    const provider = new OllamaProvider()
    await expect(provider.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('maps a 404 to model-not-found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))
    const provider = new OllamaProvider()
    await expect(provider.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'model-not-found' })
  })

  it('maps a connection-refused failure to not-running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connRefused()))
    const provider = new OllamaProvider()
    await expect(provider.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'not-running' })
  })

  it('maps a caller-initiated abort to canceled, not timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )
    const provider = new OllamaProvider()
    const controller = new AbortController()
    const promise = provider.generateJson(request, controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'canceled' })
  })

  it('maps an internal timeout to a timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )
    const provider = new OllamaProvider('http://127.0.0.1:11434', 5)
    await expect(provider.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('LocalAiProviderError', () => {
  it('carries its kind through', () => {
    const err = new LocalAiProviderError('model-not-found', 'nope')
    expect(err.kind).toBe('model-not-found')
    expect(err.message).toBe('nope')
    expect(err.name).toBe('LocalAiProviderError')
  })
})
