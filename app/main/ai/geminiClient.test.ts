import { beforeEach, describe, expect, it, vi } from 'vitest'
import { geminiKeyPool } from '@shared/geminiKeyPool'

/** A stand-in for Google: what each key answers is set per test. */
const world = vi.hoisted(() => ({
  calls: [] as { key: string; model: string; fileUri?: string }[],
  uploads: [] as { key: string; file: string }[],
  deleted: [] as { key: string; name: string }[],
  answer: (_key: string, _model: string): string | Error => 'ok',
  models: ['models/gemini-2.5-flash', 'models/gemini-3.6-flash', 'models/gemini-2.5-pro'],
  uploadError: null as ((key: string) => Error | null) | null,
  count: 0
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly key: string
    models: Record<string, unknown>
    files: Record<string, unknown>
    constructor({ apiKey }: { apiKey: string }) {
      this.key = apiKey
      this.models = {
        generateContent: async (params: { model: string; contents?: { parts?: { fileData?: { fileUri: string } }[] }[] }) => {
          const fileUri = params.contents?.[0]?.parts?.[0]?.fileData?.fileUri
          world.calls.push({ key: apiKey, model: params.model, fileUri })
          const answer = world.answer(apiKey, params.model)
          if (answer instanceof Error) throw answer
          return { text: `${answer} via ${apiKey}`, fileUri }
        },
        list: async () => world.models.map((name) => ({ name, supportedActions: ['generateContent'] }))
      }
      this.files = {
        upload: async ({ file }: { file: string }) => {
          const refused = world.uploadError?.(apiKey)
          if (refused) throw refused
          world.uploads.push({ key: apiKey, file })
          const id = ++world.count
          return { name: `files/${id}`, uri: `https://google/files/${id}`, mimeType: 'video/mp4', state: 'ACTIVE' }
        },
        get: async ({ name }: { name: string }) => ({ name, uri: `https://google/${name}`, state: 'ACTIVE', via: apiKey }),
        delete: async ({ name }: { name: string }) => {
          world.deleted.push({ key: apiKey, name })
        }
      }
    }
  }
}))

import { createGemini } from './geminiClient'

const DAILY = new Error('429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier')
const MINUTE = new Error('429 RESOURCE_EXHAUSTED per minute. Please retry in 30s')
// Google's exact words, link included: "project-unavailable" is not an overload.
const NO_FREE_TIER = new Error('{"error":{"code":403,"message":"The Gemini API free tier is not available for this project. To use the Gemini API, please set up billing to upgrade to the paid tier at https://aistudio.google.com/billing. For more information, see https://ai.google.dev/gemini-api/docs/troubleshooting#project-unavailable.","status":"PERMISSION_DENIED"}}')
const BAD_KEY = new Error('{"error":{"code":400,"message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}')

const ask = (ai: ReturnType<typeof createGemini>, model = 'gemini-2.5-flash'): Promise<{ text?: string }> => ai.models.generateContent({ model, contents: 'hi' })

// Each test gets its own keys: the client remembers what it learned per key.
let run = 0
let A: string
let B: string
let C: string

beforeEach(() => {
  // Long enough for whatever the last test left overloaded to pass.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 10, 7) + run * 60 * 60 * 1000)
  run++
  A = `keyA-${run}-aaaaaaaaaa`
  B = `keyB-${run}-bbbbbbbbbb`
  C = `keyC-${run}-cccccccccc`
  world.calls = []
  world.uploads = []
  world.deleted = []
  world.answer = () => 'ok'
  world.uploadError = null
  geminiKeyPool.setKeys([A, B, C])
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('createGemini with several keys', () => {
  it('uses the first key while it answers', async () => {
    const response = await ask(createGemini(A))
    expect(response.text).toBe(`ok via ${A}`)
    expect(world.calls).toHaveLength(1)
  })

  it('tries the other models of a key before leaving it', async () => {
    world.answer = (key, model) => (key === A && model === 'gemini-2.5-flash' ? DAILY : 'ok')
    const response = await ask(createGemini(A))
    expect(response.text).toBe(`ok via ${A}`)
    expect(world.calls.map((c) => c.model)).toEqual(['gemini-2.5-flash', 'gemini-3.6-flash'])
  })

  it('moves to the next key when a key is out for the day, and stays there', async () => {
    world.answer = (key) => (key === A ? DAILY : 'ok')
    const ai = createGemini(A)
    expect((await ask(ai)).text).toBe(`ok via ${B}`)
    world.calls = []
    expect((await ask(ai)).text).toBe(`ok via ${B}`)
    expect(world.calls.map((c) => c.key)).toEqual([B])
  })

  it('moves past a key whose project has no free tier, or a wrong key', async () => {
    world.answer = (key) => (key === A ? NO_FREE_TIER : key === B ? BAD_KEY : 'ok')
    expect((await ask(createGemini(A))).text).toBe(`ok via ${C}`)
  })

  it('moves past a per-minute limit rather than waiting', async () => {
    world.answer = (key) => (key === A ? MINUTE : 'ok')
    expect((await ask(createGemini(A))).text).toBe(`ok via ${B}`)
  })

  it('reports the per-minute limit when every key is at it, so the job waits', async () => {
    world.answer = () => MINUTE
    await expect(ask(createGemini(A))).rejects.toBe(MINUTE)
  })

  it('remembers a retired model per key, not for every key', async () => {
    const retired = new Error('404 models/gemini-2.5-flash is no longer available to new users')
    world.answer = (key, model) => (key === A && model === 'gemini-2.5-flash' ? retired : 'ok')
    const ai = createGemini(A)
    expect((await ask(ai)).text).toBe(`ok via ${A}`)
    expect(world.calls.at(-1)?.model).toBe('gemini-3.6-flash')
    geminiKeyPool.markOut(A, 60_000)
    world.calls = []
    expect((await ask(ai)).text).toBe(`ok via ${B}`)
    expect(world.calls[0]).toMatchObject({ key: B, model: 'gemini-2.5-flash' })
  })

  it('does not hammer every key while Google is overloaded', async () => {
    const busy = new Error('503 UNAVAILABLE high demand')
    world.answer = () => busy
    await expect(ask(createGemini(A))).rejects.toBe(busy)
    expect(new Set(world.calls.map((c) => c.model)).size).toBe(world.calls.length)
  })

  it('stops at an error that is not about the key', async () => {
    const wrong = new Error('400 INVALID_ARGUMENT bad schema')
    world.answer = () => wrong
    await expect(ask(createGemini(A))).rejects.toBe(wrong)
    expect(world.calls).toHaveLength(1)
  })

  it('says every key is used up, in words the app treats as quota', async () => {
    world.answer = () => DAILY
    const ai = createGemini(A)
    await expect(ask(ai)).rejects.toBe(DAILY)
    await expect(ask(ai)).rejects.toThrow(/every key/)
    await expect(ask(ai)).rejects.toThrow(/RESOURCE_EXHAUSTED/)
  })

  it('reports quota over a refused key when both happened', async () => {
    world.answer = (key) => (key === A ? NO_FREE_TIER : DAILY)
    await expect(ask(createGemini(A))).rejects.toBe(DAILY)
  })

  it('works as before with one key', async () => {
    geminiKeyPool.setKeys([A])
    world.answer = () => MINUTE
    await expect(ask(createGemini(A))).rejects.toBe(MINUTE)
    expect(world.calls).toHaveLength(1)
  })

  it('still answers with a key the pool was never told about', async () => {
    geminiKeyPool.setKeys([])
    expect((await ask(createGemini('env-key-123456'))).text).toBe('ok via env-key-123456')
  })
})

describe('uploaded files follow their key', () => {
  const askFile = (ai: ReturnType<typeof createGemini>, uri: string): Promise<{ text?: string; fileUri?: string }> =>
    ai.models.generateContent({ model: 'gemini-2.5-flash', contents: [{ parts: [{ fileData: { fileUri: uri, mimeType: 'video/mp4' } }, { text: 'watch' }] }] }) as never

  it('uploads with the key in use and reads the file with that key', async () => {
    world.answer = (key) => (key === A ? DAILY : 'ok')
    const ai = createGemini(A)
    await ask(ai)
    const file = await ai.files.upload({ file: 'clip.mp4' })
    expect(world.uploads).toEqual([{ key: B, file: 'clip.mp4' }])
    expect(await ai.files.get({ name: file.name! })).toMatchObject({ via: B })
    expect((await askFile(ai, file.uri!)).text).toBe(`ok via ${B}`)
  })

  it('uploads again with the next key when the file key runs out', async () => {
    const ai = createGemini(A)
    const file = await ai.files.upload({ file: 'clip.mp4' })
    world.answer = (key) => (key === A ? DAILY : 'ok')
    const response = await askFile(ai, file.uri!)
    expect(response.text).toBe(`ok via ${B}`)
    expect(world.uploads).toEqual([{ key: A, file: 'clip.mp4' }, { key: B, file: 'clip.mp4' }])
    expect(response.fileUri).not.toBe(file.uri)
    // Asked again: the copy already there is used.
    await askFile(ai, file.uri!)
    expect(world.uploads).toHaveLength(2)
    // Deleting the file removes both copies, each with its own key.
    await ai.files.delete({ name: file.name! })
    expect(world.deleted.map((d) => d.key).sort()).toEqual([A, B].sort())
  })

  it('moves on when a key refuses the upload', async () => {
    world.uploadError = (key) => (key === A ? NO_FREE_TIER : null)
    const ai = createGemini(A)
    await ai.files.upload({ file: 'clip.mp4' })
    expect(world.uploads).toEqual([{ key: B, file: 'clip.mp4' }])
  })

  it('reports the quota when the copy cannot be made', async () => {
    const ai = createGemini(A)
    const file = await ai.files.upload({ file: 'clip.mp4' })
    world.answer = (key) => (key === A ? DAILY : 'ok')
    world.uploadError = () => new Error('ENOENT: clip.mp4 is gone')
    await expect(askFile(ai, file.uri!)).rejects.toBe(DAILY)
  })

  it('leaves alone a file it did not upload', async () => {
    const response = await askFile(createGemini(A), 'https://google/files/elsewhere')
    expect(response.fileUri).toBe('https://google/files/elsewhere')
    expect(world.calls.map((c) => c.key)).toEqual([A])
  })
})
