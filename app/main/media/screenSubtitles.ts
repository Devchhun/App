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
/** PP-OCRv4's text detector (where in a picture there is text), ~4.7 MB.
 * Asked when the letters cannot be told from what is behind them -- white
 * subtitles over a white shirt -- see screen_subs_runner.py's Detector. */
const DET_MODEL_URLS = [
  'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_infer.onnx'
]
const DET_MODEL_FILE = 'ch_PP-OCRv4_det_infer.onnx'
const DET_MODEL_MIN_BYTES = 4 * 1024 * 1024
/** Frames read per second: lines start and end within 0.2 s. */
const FRAMES_PER_SECOND = 5
/** Where subtitles nearly always are, when they could not be found. */
const DEFAULT_BAND: DetectedBand = { x: 0.05, y: 0.72, w: 0.9, h: 0.26, score: 0 }
// Increment whenever OCR/detection changes so a sparse result produced by
// (v5: the band is found with the text detector, screen_subs_locate.py)
// an older reader (for example, 2 lines from a 20 minute video) is not reused.
const CACHE_VERSION = 'v5'

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

async function ensureModel(
  onProgress: ScreenSubtitleProgress,
  signal?: AbortSignal,
  model: { file: string; urls: string[]; minBytes: number } = { file: MODEL_FILE, urls: MODEL_URLS, minBytes: MODEL_MIN_BYTES }
): Promise<string> {
  const dir = join(app.getPath('userData'), 'models')
  const target = join(dir, model.file)
  if (existsSync(target) && (await stat(target)).size >= model.minBytes) return target
  await mkdir(dir, { recursive: true })
  let lastError: unknown = null
  for (const url of model.urls) {
    const partPath = `${target}.${Date.now()}.part`
    try {
      onProgress('Downloading the subtitle reader (once)…', 0)
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
        if (total) onProgress('Downloading the subtitle reader (once)…', received / total)
      }
      await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
      if (received < model.minBytes) throw new Error('download cut short')
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

function runRunner(jobPath: string, onFraction: (fraction: number) => void, signal?: AbortSignal, script = 'screen_subs_runner.py'): Promise<void> {
  const python = getBundledPythonPath()
  if (!python) return Promise.reject(new Error("Reading on-screen subtitles needs the app's bundled Python, which this build is missing. Reinstalling the app should restore it."))
  return new Promise((resolve, reject) => {
    const proc = runInBackground(spawn(python, [join(scriptDir(), script), jobPath], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }))
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

/** Where the subtitles are, found with the text detector (see
 * python-worker/screen_subs_locate.py): null when no line of text keeps
 * coming back at one height. The band it gives is one line of text, as
 * wide as the lines seen; it is grown here to what a subtitle can take up
 * -- two lines (a second one sits above the usual one) and most of the
 * width, centred -- since the reader only reads the rows that hold text. */
async function locateSubtitles(videoPath: string, detModel: string, duration: number, width: number, height: number, cacheDir: string, signal?: AbortSignal): Promise<DetectedBand | null> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const jobPath = join(cacheDir, `screen-subs-locate-${id}.json`)
  const outPath = join(cacheDir, `screen-subs-located-${id}.json`)
  await writeFile(jobPath, JSON.stringify({ ffmpeg: ffmpegPath, video: videoPath, detModel, out: outPath, duration, height: Math.max(16, Math.round((960 * height) / width / 2) * 2) }), 'utf-8')
  try {
    await runRunner(jobPath, () => undefined, signal, 'screen_subs_locate.py')
    const found = JSON.parse(await readFile(outPath, 'utf-8')) as { band: { x: number; y: number; w: number; h: number } | null; frames: number; withText: number }
    if (!found.band) return null
    const line = found.band.h
    const bottom = Math.min(1, found.band.y + line * 1.6)
    const top = Math.max(0, found.band.y - line * 1.6)
    const w = Math.min(1, Math.max(found.band.w, 0.84))
    return { x: (1 - w) / 2, y: top, w, h: bottom - top, score: found.frames ? found.withText / found.frames : 0 }
  } finally {
    await unlink(jobPath).catch(() => undefined)
    await unlink(outPath).catch(() => undefined)
  }
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

  const model = await ensureModel(onProgress, signal)
  // The detector only improves the reading: without it (offline the first
  // time) the reader still works as it did.
  const detModel = await ensureModel(onProgress, signal, { file: DET_MODEL_FILE, urls: DET_MODEL_URLS, minBytes: DET_MODEL_MIN_BYTES }).catch((error) => {
    if (signal?.aborted) throw error
    console.warn('[screen-subtitles] text detector not available:', error)
    return undefined
  })
  onProgress('Looking for subtitles in the picture…', 0)
  // Where the subtitles are: asked of the text detector when it is here --
  // the bright-edge finder below put the band in the middle of a bright or
  // busy picture and every line of dialogue was missed (three of four 4K
  // episodes, measured) -- and of that finder only without the detector.
  let found: DetectedBand | null | undefined
  if (detModel) {
    found = await locateSubtitles(videoPath, detModel, duration, width, height, cacheDir, signal).catch((error) => {
      if (signal?.aborted) throw error
      console.warn('[screen-subtitles] text detector could not look for the subtitles:', error)
      return undefined
    })
  }
  if (found === undefined) found = await detectBurnedSubtitles(videoPath, [])
  if (signal?.aborted) throw new Error('Canceled')
  if (!found && options.requireBand) return null
  const band = found ? readingBand(found) : DEFAULT_BAND
  // Read at the picture's own size up to 1080p (by its short side, so a
  // vertical 720x1280 film is not shrunk: its small letters lost their
  // spaces and a stroke or two at 800 px -- "Threehundredyears"); a 4K
  // frame, whose letters are twice as large, is halved first.
  const scale = Math.min(1, 1100 / Math.min(width, height))
  const even = (n: number): number => Math.max(16, Math.round(n / 2) * 2)
  const runBand = async (candidate: DetectedBand): Promise<ScreenSubtitleLine[]> => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const jobPath = join(cacheDir, `screen-subs-job-${id}.json`)
    const outPath = join(cacheDir, `screen-subs-out-${id}.json`)
    await writeFile(
      jobPath,
      JSON.stringify({
        ffmpeg: ffmpegPath,
        video: videoPath,
        model,
        detModel,
        keys: join(scriptDir(), 'ppocr_keys_v1.txt'),
        out: outPath,
        band: { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h },
        bandWidth: even(candidate.w * width * scale),
        bandHeight: even(candidate.h * height * scale),
        ranges: ranges.map((r) => [r.start, r.end]),
        fps: FRAMES_PER_SECOND
      }),
      'utf-8'
    )
    try {
      onProgress('Reading the subtitles in the picture…', 0)
      await runRunner(jobPath, (fraction) => onProgress('Reading the subtitles in the picture…', fraction), signal)
      return JSON.parse(await readFile(outPath, 'utf-8')) as ScreenSubtitleLine[]
    } finally {
      await unlink(jobPath).catch(() => undefined)
      await unlink(outPath).catch(() => undefined)
    }
  }

  let lines = await runBand(band)
  const scannedSeconds = ranges.reduce((sum, range) => sum + range.end - range.start, 0)
  // Automatic band detection can lock onto a bright logo or a sign. In the
  // explicit mode, retry the conventional lower area when the first pass is
  // implausibly sparse and keep whichever pass found more timed lines.
  if (found && options.requireBand === false && !looksLikeSubtitles(lines, scannedSeconds)) {
    const fallback = await runBand(DEFAULT_BAND)
    if (fallback.length > lines.length) lines = fallback
  }
  await writeFile(cachePath, JSON.stringify(lines), 'utf-8').catch(() => undefined)
  return lines
}

/** The area that is read, from the band the subtitles were found in. That
 * band is where MOST lines are -- one line of average length. A two-line
 * subtitle reaches half a band higher and lower, and a long line further
 * out to the sides: read through the tight band, such lines came out cut
 * in half ("Martiahcetsentademy" for "Once I enter / Martial Arts
 * Academy"). */
export function readingBand(found: DetectedBand): DetectedBand {
  const padY = found.h * 0.5
  const y = Math.max(0, found.y - padY)
  const h = Math.min(1 - y, found.h + padY * 2)
  const x = Math.min(found.x, 0.05)
  const w = Math.max(found.x + found.w, 0.95) - x
  return { ...found, x, y, w, h }
}

/** Enough lines, often enough, to be a video's subtitles -- not a logo or a
 * sign read now and then. */
export function looksLikeSubtitles(lines: ScreenSubtitleLine[], seconds: number): boolean {
  const minutes = Math.max(1, seconds / 60)
  if (lines.length < 5 || lines.length / minutes < 2) return false
  // Read with little certainty throughout: text in a script the reader
  // does not know (Khmer, Thai), not its Chinese or Latin letters.
  const sure = lines.filter((line) => line.confidence >= 0.8).length
  return sure / lines.length >= 0.6
}
