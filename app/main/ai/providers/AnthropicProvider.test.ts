import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicProvider } from './AnthropicProvider'
import { ProviderError } from './AiProvider'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function toolUseResponse(results: unknown[]): Response {
  return jsonResponse(200, {
    content: [{ type: 'tool_use', name: 'classify_segments', input: { results } }]
  })
}

const VALID_RESULT = { segmentId: 's1', purpose: 'main_claim', visualText: 'Key point', reason: 'Because', confidence: 0.9 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnthropicProvider.classifySegments -- structured-output parsing', () => {
  it('parses a valid tool_use response into classification results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolUseResponse([VALID_RESULT])))
    const provider = new AnthropicProvider()
    const results = await provider.classifySegments('key', [{ segmentId: 's1', text: 'hello' }], new AbortController().signal)
    expect(results).toEqual([VALID_RESULT])
  })

  it('drops schema-invalid entries but keeps valid ones (partial validity)', async () => {
    const invalid = { segmentId: 's2', purpose: 'not-a-real-purpose', visualText: 'x', reason: 'y', confidence: 0.5 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolUseResponse([VALID_RESULT, invalid])))
    const provider = new AnthropicProvider()
    const results = await provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)
    expect(results).toEqual([VALID_RESULT])
  })

  it('throws a schema error when every entry is invalid', async () => {
    const invalid = { segmentId: '', purpose: 'nope', visualText: '', reason: 1, confidence: 'x' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolUseResponse([invalid])))
    const provider = new AnthropicProvider()
    await expect(provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)).rejects.toMatchObject({
      kind: 'schema'
    })
  })

  it('throws a schema error when there is no tool_use block at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: 'text', text: 'no tool call' }] })))
    const provider = new AnthropicProvider()
    await expect(provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)).rejects.toMatchObject({
      kind: 'schema'
    })
  })

  it('throws malformed on an empty/missing content array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})))
    const provider = new AnthropicProvider()
    await expect(provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)).rejects.toMatchObject({
      kind: 'malformed'
    })
  })

  it('throws malformed when the response body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json{{{', { status: 200, headers: { 'content-type': 'application/json' } }))
    )
    const provider = new AnthropicProvider()
    await expect(provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)).rejects.toMatchObject({
      kind: 'malformed'
    })
  })

  it('returns an empty array without making any request for zero segments', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicProvider()
    const results = await provider.classifySegments('key', [], new AbortController().signal)
    expect(results).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('AnthropicProvider -- HTTP error handling', () => {
  it('maps 401 to an auth error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })))
    const provider = new AnthropicProvider()
    await expect(provider.classifySegments('bad-key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)).rejects.toMatchObject(
      { kind: 'auth' }
    )
  })

  it('maps 429 to a rate-limit error and surfaces retry-after', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '12' })))
    const provider = new AnthropicProvider()
    try {
      await provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).kind).toBe('rate-limit')
      expect((err as ProviderError).retryAfterSeconds).toBe(12)
    }
  })

  it('maps a network failure (offline) to a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const provider = new AnthropicProvider()
    await expect(provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)).rejects.toMatchObject({
      kind: 'network'
    })
  })
})

describe('AnthropicProvider -- cancellation and timeout', () => {
  it('maps a caller-initiated abort to a canceled error, not a timeout', async () => {
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
    const provider = new AnthropicProvider()
    const controller = new AbortController()
    const promise = provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'canceled' })
  })

  it('maps an internal timeout to a timeout error when the caller did not cancel', async () => {
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
    // 5ms timeout so the test doesn't have to wait anywhere near the real 60s default.
    const provider = new AnthropicProvider(5)
    await expect(
      provider.classifySegments('key', [{ segmentId: 's1', text: 'a' }], new AbortController().signal)
    ).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('AnthropicProvider.simplifyText', () => {
  it('returns the simplified phrase from a valid tool_use response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: 'tool_use', name: 'simplify_text', input: { simplified: 'Short phrase' } }] }))
    )
    const provider = new AnthropicProvider()
    const result = await provider.simplifyText('key', 'A much longer original phrase', new AbortController().signal)
    expect(result).toBe('Short phrase')
  })

  it('throws schema error when the simplified field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: 'tool_use', name: 'simplify_text', input: {} }] })))
    const provider = new AnthropicProvider()
    await expect(provider.simplifyText('key', 'text', new AbortController().signal)).rejects.toMatchObject({ kind: 'schema' })
  })
})
