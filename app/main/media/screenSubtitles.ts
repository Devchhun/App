import { spawn } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { ffmpegPath } from './ffmpeg'
import { probeMedia } from './probe'
import { runInBackground } from './processPriority'
import { detectBurnedSubtitles } from './subtitleDetect'
import { getBundledPythonPath } from '../ai/pythonRuntime'
import type { DetectedBand } from '@shared/subtitleDetect'

/** PP-OCRv4's Chinese (and English) text-line recognizer, as ONNX --
 * downloaded once, the first time it is needed, into the app's data.
 * Its character list ships with the app (python-worker/ppocr_keys_v1.txt). */
const MODEL_URLS = [
  'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx',
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_infer.onnx'
]
const MODEL_FILE = 'ch_PP-OCRv4_rec_infer.onnx'
/** The model is ~10.4 MB: anything much smaller is a broken download. */
const MODEL_MIN_BYTES = 9 * 1024 * 1024
/** Frames read per second: lines start and end within 0.2 s. */
const FRAMES_PER_SECOND = 5
/** Where subtitles nearly always are, when they could not be found. */
const DEFAULT_BAND: DetectedBand = { x: 0.05, y: 0.72, w: 0.9, h: 0.26, score: 0 }
const CACHE_VERSION = 'v1'

export interface ScreenSubtitleLine {
  start: number
  end: number
  text: string
  /** The recognizer's own confidence (0-1), averaged over the line's frames. */
  confidence: number
  /** Frames the line was read in. */
  frames: number
}

export type ScreenSubtitleProgress = (message: string, fraction: number) => void

function scriptDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python-worker') : join(__dirname, '../../python-worker')
}

async function ensureModel(onProgress: ScreenSubtitleProgress, signal?: AbortSignal): Promise<string> {
  const dir = join(app.getPath('userData'), 'models')
  const target = join(dir, MODEL_FILE)
  if (existsSync(target) && (await stat(target)).size >= MODEL_MIN_BYTES) return target
  await mkdir(dir, { recursive: true })
  let lastError: unknown = null
  for (const url of MODEL_URLS) {
    const partPath = `${target}.${Date.now()}.part`
    try {
      onProgress('Downloading the subtitle reader (once, ~10 MB)…', 0)
      const res = await fetch(url, { signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      const file = createWriteStream(partPath)
      let received = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
        if (total) onProgress('Downloading the subtitle reader (once, ~10 MB)…', received / total)
      }
      await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
      if (received < MODEL_MIN_BYTES) throw new Error('download cut short')
      await rename(partPath, target)
      return target
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    } finally {
      await unlink(partPath).catch(() => undefined)
    }
  }
  throw new Error(`The subtitle reader could not be downloaded (${lastError instanceof Error ? lastError.message : String(lastError)}). Check the internet connection and try again.`)
}

function runRunner(jobPath: string, onFraction: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  const python = getBundledPythonPath()
  if (!python) return Promise.reject(new Error("Reading on-screen subtitles needs the app's bundled Python, which this build is missing. Reinstalling the app should restore it."))
  return new Promise((resolve, reject) => {
    const proc = runInBackground(spawn(python, [join(scriptDir(), 'screen_subs_runner.py'), jobPath], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }))
    let tail = ''
    let ok = false
    let pending = ''
    proc.stdout.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^progress ([\d.]+)/.exec(line)
        if (m) onFraction(Number(m[1]))
        else if (/^ok /.test(line)) ok = true
      }
    })
    proc.stderr.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)))
    const onAbort = (): void => {
      proc.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(new Error('Canceled'))
      else if (code === 0 && (ok || /^ok /m.test(pending))) resolve()
      else reject(new Error(tail.trim().split('\n').slice(-3).join('\n') || `The subtitle reader stopped (code ${code}).`))
    })
  })
}

/** The subtitles drawn into `videoPath`'s picture, as timed lines (seconds
 * in the file) -- only inside `ranges` when given. `band` is where to look;
 * found automatically when absent, or null when the video seems to have no
 * burned-in subtitles (`requireBand`) -- the whole lower part is read then
 * otherwise. Results are kept in `cacheDir`: a second run is instant. */
export async function readScreenSubtitles(options: {
  videoPath: string
  cacheDir: string
  ranges?: { start: number; end: number }[]
  requireBand?: boolean
  signal?: AbortSignal
  onProgress: ScreenSubtitleProgress
}): Promise<ScreenSubtitleLine[] | null> {
  const { videoPath, cacheDir, signal, onProgress } = options
  const meta = await probeMedia(videoPath)
  const duration = meta.durationSeconds ?? 0
  const width = meta.width ?? 1920
  const height = meta.height ?? 1080
  if (!(duration > 0)) throw new Error('Could not read the video length.')
  const ranges = (options.ranges?.length ? options.ranges : [{ start: 0, end: duration }])
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end - r.start > 0.2)
  if (ranges.length === 0) return []
  const cachePath = join(cacheDir, `screen-subs-${CACHE_VERSION}-${ranges.map((r) => `${r.start.toFixed(1)}_${r.end.toFixed(1)}`).join('-').slice(0, 120)}.json`)
  const cached = await readFile(cachePath, 'utf-8')
    .then((text) => JSON.parse(text) as ScreenSubtitleLine[])
    .catch(() => null)
  if (cached) return cached

  onProgress('Looking for subtitles in the picture…', 0)
  const found = await detectBurnedSubtitles(videoPath, [])
  if (signal?.aborted) throw new Error('Canceled')
  if (!found && options.requireBand) return null
  const band = found ?? DEFAULT_BAND
  const model = await ensureModel(onProgress, signal)
  // About 80 px for a band a tenth of the frame tall: plenty for the
  // letters, and a 4K frame shrinks before it is read.
  const scale = Math.min(1, 800 / height)
  const even = (n: number): number => Math.max(16, Math.round(n / 2) * 2)
  const jobPath = join(cacheDir, `screen-subs-job-${Date.now().toString(36)}.json`)
  const outPath = join(cacheDir, `screen-subs-out-${Date.now().toString(36)}.json`)
  await writeFile(
    jobPath,
    JSON.stringify({
      ffmpeg: ffmpegPath,
      video: videoPath,
      model,
      keys: join(scriptDir(), 'ppocr_keys_v1.txt'),
      out: outPath,
      band: { x: band.x, y: band.y, w: band.w, h: band.h },
      bandWidth: even(band.w * width * scale),
      bandHeight: even(band.h * height * scale),
      ranges: ranges.map((r) => [r.start, r.end]),
      fps: FRAMES_PER_SECOND
    }),
    'utf-8'
  )
  try {
    onProgress('Reading the subtitles in the picture…', 0)
    await runRunner(jobPath, (fraction) => onProgress('Reading the subtitles in the picture…', fraction), signal)
    const lines = JSON.parse(await readFile(outPath, 'utf-8')) as ScreenSubtitleLine[]
    await writeFile(cachePath, JSON.stringify(lines), 'utf-8').catch(() => undefined)
    return lines
  } finally {
    await unlink(jobPath).catch(() => undefined)
    await unlink(outPath).catch(() => undefined)
  }
}

/** Enough lines, often enough, to be a video's subtitles -- not a logo or a
 * sign read now and then. */
export function looksLikeSubtitles(lines: ScreenSubtitleLine[], seconds: number): boolean {
  const minutes = Math.max(1, seconds / 60)
  return lines.length >= 5 && lines.length / minutes >= 2
}
