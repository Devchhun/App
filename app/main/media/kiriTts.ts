import { readFile, writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { runFfmpeg } from './jobRunner'
import { isolateVoice } from './vocalRemoval'
import { getKiriApiKey } from '../ai/kiriApiKeyStore'
import { explainKiriError, isRetryableKiriStatus, parseKiriVoices, KIRI_API_BASE, KIRI_CLONE_MAX_SECONDS, KIRI_INPUT_MAX, KIRI_MODEL, type KiriCloneOptions, type KiriVoice } from '@shared/kiriTts'

/** KiriTTS over HTTPS (see shared/kiriTts.ts). Rate limits and server
 * hiccups are retried after a pause; a bad key, a plan without API access
 * and used-up credits fail at once with a message that says which. */
export class KiriTtsError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
    this.name = 'KiriTtsError'
  }
}

const RETRY_PAUSES_MS = [2000, 6000, 15000]

/** The server, overridable for tests (a local stand-in). */
function apiBase(): string {
  return process.env.KIRI_API_BASE?.trim() || KIRI_API_BASE
}

async function requireKey(): Promise<string> {
  const key = await getKiriApiKey()
  // 401: as the service answers a bad key -- it stops a whole run, where a
  // line's own trouble (no audio back, nothing to say) fails only that line.
  if (!key) throw new KiriTtsError('No KiriTTS API key -- add it in Settings > AI API Keys.', 401)
  return key
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

async function kiriFetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${apiBase()}${path}`, { ...init, signal })
    if (res.ok) return res
    const body = await res.text().catch(() => '')
    if (attempt < RETRY_PAUSES_MS.length && isRetryableKiriStatus(res.status, body) && !signal?.aborted) {
      await sleep(RETRY_PAUSES_MS[attempt], signal)
      if (signal?.aborted) throw new KiriTtsError('Canceled')
      continue
    }
    throw new KiriTtsError(explainKiriError(res.status, body), res.status)
  }
}

export async function kiriListVoices(): Promise<KiriVoice[]> {
  const key = await requireKey()
  const res = await kiriFetch('/voices', { headers: { Authorization: `Bearer ${key}` } })
  return parseKiriVoices(await res.json())
}

/** One line of speech into `outPath` (WAV). `speed` (KiriTTS's own,
 * 0.7-1.2) and `instructions` do not go together -- the service refuses a
 * speed other than 1 alongside instructions -- so a speed wins. */
export async function kiriSpeakLine(voice: string, text: string, outPath: string, options: { instructions?: string; speed?: number; signal?: AbortSignal } = {}): Promise<void> {
  const key = await requireKey()
  const input = text.trim().slice(0, KIRI_INPUT_MAX)
  if (!input) throw new KiriTtsError('Nothing to say on this line.')
  const res = await kiriFetch(
    '/audio/speech',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        model: KIRI_MODEL,
        input,
        voice,
        response_format: 'wav',
        ...(options.speed && options.speed !== 1 ? { speed: options.speed } : options.instructions ? { instructions: options.instructions } : {})
      })
    },
    options.signal
  )
  const audio = Buffer.from(await res.arrayBuffer())
  if (audio.length < 100) throw new KiriTtsError('KiriTTS returned no audio for this line.')
  await writeFile(outPath, audio)
}

/** A new cloned voice from a recording (or a video's sound): its first 30
 * seconds as mono WAV -- every clone on a real account is 30.0 s, which is
 * what the service keeps. */
export async function kiriCloneVoice(name: string, sourcePath: string, options: KiriCloneOptions = {}): Promise<KiriVoice> {
  const key = await requireKey()
  const clean = name.trim()
  if (!clean) throw new KiriTtsError('Give the voice a name.')
  const work = await mkdtemp(join(tmpdir(), 'kiri-clone-'))
  try {
    // Only the chosen stretch (the first 30 s of a drama video is usually
    // titles and music, not the character).
    const start = Math.max(0, options.start ?? 0)
    const duration = Math.min(KIRI_CLONE_MAX_SECONDS, Math.max(1, options.duration ?? KIRI_CLONE_MAX_SECONDS))
    const excerpt = join(work, 'excerpt.wav')
    await runFfmpeg(`kiri-clone-cut-${Date.now()}`, ['-y', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', sourcePath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', excerpt])
    let voiceSource = excerpt
    if (options.isolateVoice && options.installDir) {
      const isolated = await isolateVoice(`kiri-clone-iso-${Date.now()}`, excerpt, options.installDir)
      if (!isolated) throw new KiriTtsError('Could not take the voice out of the music (needs the VoxCPM2 runtime in Settings > Voice Engine). Untick "Remove music & noise" to clone the recording as it is.')
      voiceSource = isolated
    }
    const wav = join(work, 'reference.wav')
    await runFfmpeg(`kiri-clone-${Date.now()}`, ['-y', '-i', voiceSource, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wav])
    const form = new FormData()
    form.append('name', clean)
    form.append('file', new Blob([await readFile(wav)], { type: 'audio/wav' }), `${basename(sourcePath).replace(/\.[^.]+$/, '') || 'reference'}.wav`)
    const res = await kiriFetch('/audio/voice-clones', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form })
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string }
    const id = body.id || body.name || clean
    return { id, name: body.name || id, cloned: true, gender: 'unknown' }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
