import { spawn } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, mkdtemp, rename, rm, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { runFfmpeg } from './jobRunner'
import { runInBackground } from './processPriority'
import { cacheKeyForFile, ensureCacheDir } from './cache'
import { getBundledPythonPath } from '../ai/pythonRuntime'

/** IS-Net (general use), the model rembg ships for "remove background" --
 * downloaded once, the first time it is needed, into the app's data. */
const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx'
const MODEL_FILE = 'isnet-general-use.onnx'
/** The model's real size: anything much smaller is a broken download. */
const MODEL_MIN_BYTES = 150 * 1024 * 1024
/** IS-Net's own input size. */
const MODEL_SIZE = 1024
const RESULT_FILE = 'no-background-isnet.png'

export type RemoveBackgroundProgress = (stage: string, percent: number) => void

function runnerPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python-worker', 'remove_bg_runner.py') : join(__dirname, '../../python-worker/remove_bg_runner.py')
}

function modelPath(): string {
  return join(app.getPath('userData'), 'models', MODEL_FILE)
}

/** The model on disk, downloaded first if it is not there yet. */
async function ensureModel(onProgress: RemoveBackgroundProgress, signal?: AbortSignal): Promise<string> {
  const target = modelPath()
  if (existsSync(target) && (await stat(target)).size >= MODEL_MIN_BYTES) return target
  await mkdir(join(app.getPath('userData'), 'models'), { recursive: true })
  const partPath = `${target}.${Date.now()}.part`
  onProgress('Downloading the background model (once, ~180 MB)', 0)
  try {
    const res = await fetch(MODEL_URL, { signal })
    if (!res.ok || !res.body) throw new Error(`The background model could not be downloaded (HTTP ${res.status}). Check the internet connection and try again.`)
    const total = Number(res.headers.get('content-length')) || 0
    const file = createWriteStream(partPath)
    let received = 0
    let lastReported = -1
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
      const percent = total ? Math.floor((received / total) * 100) : 0
      if (percent !== lastReported) {
        lastReported = percent
        onProgress('Downloading the background model (once, ~180 MB)', percent)
      }
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
    if (received < MODEL_MIN_BYTES) throw new Error('The background model download was cut short. Try again.')
    await rename(partPath, target)
    return target
  } finally {
    await unlink(partPath).catch(() => undefined)
  }
}

function runPython(args: string[], signal?: AbortSignal): Promise<string> {
  const python = getBundledPythonPath()
  if (!python) return Promise.reject(new Error("Remove Background needs the app's bundled Python, which this build is missing. Reinstalling the app should restore it."))
  return new Promise((resolve, reject) => {
    const proc = runInBackground(spawn(python, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }))
    let out = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (out += d.toString()))
    const onAbort = (): void => {
      proc.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0 && /^ok /m.test(out)) resolve(out)
      else reject(new Error(out.trim().split('\n').slice(-3).join('\n') || `The background model stopped (code ${code}).`))
    })
  })
}

/** The picture with its background taken away: a PNG whose alpha is the
 * subject IS-Net finds, kept beside the image's other cached files (a
 * second Remove Background on the same picture is instant). */
export async function removeImageBackground(jobId: string, imagePath: string, onProgress: RemoveBackgroundProgress, signal?: AbortSignal): Promise<string> {
  const cacheDir = await ensureCacheDir(await cacheKeyForFile(imagePath))
  const outputPath = join(cacheDir, RESULT_FILE)
  if (existsSync(outputPath)) {
    onProgress('Done', 100)
    return outputPath
  }
  const model = await ensureModel(onProgress, signal)
  const workDir = await mkdtemp(join(tmpdir(), 'remove-bg-'))
  try {
    onProgress('Finding the subject', 0)
    const rgbPath = join(workDir, 'input.rgb')
    const maskPath = join(workDir, 'mask.gray')
    await runFfmpeg(`${jobId}:in`, ['-y', '-i', imagePath, '-frames:v', '1', '-vf', `scale=${MODEL_SIZE}:${MODEL_SIZE}:flags=bilinear,format=rgb24`, '-f', 'rawvideo', rgbPath])
    if (signal?.aborted) throw new Error('Canceled')
    await runPython([runnerPath(), model, rgbPath, maskPath, String(MODEL_SIZE)], signal)
    onProgress('Cutting out', 80)
    // The mask back at the picture's own size, as its alpha.
    const tmpOut = join(cacheDir, `no-background.${Date.now().toString(36)}.tmp.png`)
    try {
      await runFfmpeg(`${jobId}:out`, [
        '-y',
        '-i',
        imagePath,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-s',
        `${MODEL_SIZE}x${MODEL_SIZE}`,
        '-i',
        maskPath,
        '-filter_complex',
        '[1:v][0:v]scale2ref=flags=bicubic[mask][picture];[picture]format=rgba[rgba];[rgba][mask]alphamerge',
        '-frames:v',
        '1',
        tmpOut
      ])
      await rename(tmpOut, outputPath)
    } finally {
      await unlink(tmpOut).catch(() => undefined)
    }
    onProgress('Done', 100)
    return outputPath
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
