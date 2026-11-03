import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const dataDir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({ app: { getPath: () => dataDir.path } }))
vi.mock('./jobRunner', () => ({ runFfmpeg: vi.fn() }))
vi.mock('./vocalRemoval', () => ({ isolateVoice: vi.fn() }))
vi.mock('../ai/kiriApiKeyStore', () => ({ getKiriApiKey: async () => 'test-key' }))

/** What fetch does when the connection itself fails -- it throws, it does
 * not answer. */
const dropped = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'))
const audio = (): Promise<Response> => Promise.resolve(new Response(new Uint8Array(400), { status: 200 }))

let workDir: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'cae-kiri-test-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await rm(workDir, { recursive: true, force: true })
})

describe('KiriTTS over a connection that drops', () => {
  it('a short drop is ridden out: the line is made on a later try', async () => {
    const { kiriSpeakLine } = await import('./kiriTts')
    fetchMock.mockImplementationOnce(dropped).mockImplementationOnce(dropped).mockImplementationOnce(audio)
    const outPath = join(workDir, 'line.wav')
    const made = kiriSpeakLine('voice', 'Hello there', outPath).then(
      () => 'made',
      (err: Error) => err
    )
    await vi.advanceTimersByTimeAsync(2000 + 6000)
    expect(await made).toBe('made')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((await stat(outPath)).size).toBe(400)
  })

  it('no connection at all says so in plain words, and is marked as "could not be reached"', async () => {
    const { kiriSpeakLine, KiriTtsError, KIRI_UNREACHABLE } = await import('./kiriTts')
    fetchMock.mockImplementation(dropped)
    const made = kiriSpeakLine('voice', 'Hello there', join(workDir, 'line.wav')).then(
      () => 'made',
      (err: Error) => err
    )
    await vi.advanceTimersByTimeAsync(2000 + 6000 + 15000)
    const err = await made
    expect(err).toBeInstanceOf(KiriTtsError)
    expect((err as InstanceType<typeof KiriTtsError>).status).toBe(KIRI_UNREACHABLE)
    expect((err as Error).message).toMatch(/Could not reach KiriTTS/)
    expect((err as Error).message).not.toMatch(/fetch failed/)
    // The first ask and one after each pause -- then it stops asking.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('canceling during the wait stops it there', async () => {
    const { kiriSpeakLine } = await import('./kiriTts')
    fetchMock.mockImplementation(dropped)
    const controller = new AbortController()
    const made = kiriSpeakLine('voice', 'Hello there', join(workDir, 'line.wav'), { signal: controller.signal }).then(
      () => 'made',
      (err: Error) => err
    )
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()
    await vi.advanceTimersByTimeAsync(30000)
    expect(((await made) as Error).message).toBe('Canceled')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a connection lost while the audio is coming back is reported the same way', async () => {
    const { kiriSpeakLine, KIRI_UNREACHABLE } = await import('./kiriTts')
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.reject(new TypeError('terminated')) } as unknown as Response))
    const err = await kiriSpeakLine('voice', 'Hello there', join(workDir, 'line.wav')).then(
      () => null,
      (e: Error & { status?: number }) => e
    )
    expect(err?.status).toBe(KIRI_UNREACHABLE)
    expect(err?.message).toMatch(/Could not reach KiriTTS/)
  })

  it('an answer from the service is still read as before: a bad key fails at once, with no retry', async () => {
    const { kiriSpeakLine } = await import('./kiriTts')
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })))
    const err = await kiriSpeakLine('voice', 'Hello there', join(workDir, 'line.wav')).then(
      () => null,
      (e: Error & { status?: number }) => e
    )
    expect(err?.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a voice\'s kept sample', () => {
  const wav = (): Promise<Response> => Promise.resolve(new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, ...new Array(400).fill(1)]), { status: 200 }))

  beforeEach(() => {
    dataDir.path = workDir
    vi.useRealTimers()
  })

  it('is made once, and stays for every later listen', async () => {
    const { kiriVoiceSampleFile } = await import('./kiriTts')
    fetchMock.mockImplementation(wav)
    const first = await kiriVoiceSampleFile('Voice A')
    const again = await kiriVoiceSampleFile('Voice A')
    expect(again).toBe(first)
    expect(first.startsWith(join(workDir, 'kiri-samples'))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks once when clicked twice while it is being made', async () => {
    const { kiriVoiceSampleFile } = await import('./kiriTts')
    fetchMock.mockImplementation(wav)
    const [a, b] = await Promise.all([kiriVoiceSampleFile('Voice B'), kiriVoiceSampleFile('Voice B')])
    expect(a).toBe(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes it again when a PC reset left the file full of zeros', async () => {
    const { kiriVoiceSampleFile } = await import('./kiriTts')
    fetchMock.mockImplementation(wav)
    const path = await kiriVoiceSampleFile('Voice C')
    await writeFile(path, new Uint8Array(400))
    await kiriVoiceSampleFile('Voice C')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await readFile(path)).subarray(0, 4).toString('latin1')).toBe('RIFF')
  })

  it('leaves no half-made file when it cannot be made', async () => {
    const { kiriVoiceSampleFile } = await import('./kiriTts')
    fetchMock.mockImplementation(() => Promise.resolve(new Response('no', { status: 401 })))
    await expect(kiriVoiceSampleFile('Voice D')).rejects.toThrow()
    const left = await readdir(join(workDir, 'kiri-samples')).catch(() => [] as string[])
    expect(left.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
