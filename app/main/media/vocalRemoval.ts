import { existsSync } from 'fs'
import { mkdir, mkdtemp, rename, rm } from 'fs/promises'
import { tmpdir, totalmem } from 'os'
import { basename, dirname, join } from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import { cancelJob, runFfmpeg } from './jobRunner'
import { ffmpegPath } from './ffmpeg'
import { cacheKeyForFile, ensureCacheDir, getMediaCacheRoot } from './cache'
import { probeAudioChannels, probeMedia } from './probe'
import type { VoxCpmDevice } from '@shared/dubbing'
import { planSeparationChunks } from '@shared/vocalRemoval'
import { runInBackground } from './processPriority'
import { backgroundThreadCount } from './hwAccel'

/** Center-channel cancellation -- the classic "karaoke" trick. Kept only as
 * the last-resort fallback when the real separator below can't run: it
 * subtracts one channel from the other, so it removes ANYTHING mixed dead
 * centre (dialogue, but also bass, kick, and most effects) and leaves
 * anything panned wide -- and on a dual-mono source (identical L/R, which
 * most video is) L-R is zero everywhere and the "instrumental" comes out
 * as pure silence. That last case is why this must never run unguarded:
 * see hasUsableStereoWidth. */
export function buildVocalRemovalFilter(): string {
  return 'pan=stereo|c0=c0-c1|c1=c1-c0'
}

/** Whether center-channel cancellation can work at all on this file: it
 * needs a real stereo track, since the technique IS the difference between
 * the two channels. */
export async function hasStereoAudio(sourcePath: string): Promise<boolean> {
  return (await probeAudioChannels(sourcePath)) >= 2
}

/** Two channels is not enough -- they also have to DIFFER. Measures the
 * side (L-R) signal's level against the mid (L+R): a genuinely stereo mix
 * sits well above -30dB; dual-mono sits at -inf, and a near-mono mix at
 * -40 and below cancels to a whisper. Read from ffmpeg's own astats. */
export function hasUsableStereoWidth(sourcePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // astats reports on stderr, which runFfmpeg doesn't surface -- a direct
    // spawn of the same binary is simpler than widening that helper.
    const proc = spawn(ffmpegPath, ['-i', sourcePath, '-vn', '-af', 'pan=mono|c0=c0-c1,astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-'])
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', () => resolve(true)) // couldn't measure -- don't block the user on a guess
    proc.on('close', () => {
      const match = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(stderr)
      if (!match) return resolve(true)
      const sideDb = match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
      resolve(sideDb > -45)
    })
  })
}

/** Where the htdemucs weights live -- shipped as an extraResource (see
 * electron-builder.yml), read from the checkout's resources/ in dev. */
export function demucsModelRepo(): string {
  return app.isPackaged ? join(process.resourcesPath, 'demucs-models') : join(__dirname, '../../resources/demucs-models')
}

/** The only Python on the machine with torch+CUDA is the VoxCPM2 portable
 * runtime, so the separator runs from there too. `demucs` itself is a pure-
 * Python package on top of that torch; it's installed into that runtime on
 * first use if missing (needs internet once), never touching torch. */
function separatorPython(installDir: string): string {
  return join(installDir, 'voxcpm_runtime', 'python.exe')
}

function runPython(
  pythonExe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stallMs: number,
  onStderr?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = runInBackground(spawn(pythonExe, args, { env }))
    const onAbort = (): void => {
      proc.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let stderr = ''
    let stallTimer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => proc.kill(), stallMs)
    }
    arm()
    proc.stdout.on('data', arm)
    proc.stderr.on('data', (chunk: Buffer) => {
      arm()
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
      onStderr?.(text)
    })
    proc.on('error', (err) => {
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderr })
    })
  })
}

export async function ensureDemucsInstalled(installDir: string): Promise<boolean> {
  const py = separatorPython(installDir)
  if (!existsSync(py)) return false
  const probe = await runPython(py, ['-c', 'import demucs'], process.env, 60_000)
  if (probe.code === 0) return true
  const install = await runPython(py, ['-m', 'pip', 'install', '--quiet', 'demucs'], process.env, 10 * 60_000)
  return install.code === 0
}

export interface RemoveVocalsOptions {
  installDir: string
  device: VoxCpmDevice
  /** Called with 0-100 across the whole job and a short label for the
   * current step, as often as Demucs itself reports. */
  onProgress?: (percent: number, stage: string) => void
  /** Stops the job; it then rejects with VocalRemovalCanceledError. */
  signal?: AbortSignal
}

export class VocalRemovalCanceledError extends Error {
  constructor() {
    super('Canceled')
    this.name = 'VocalRemovalCanceledError'
  }
}

/** The instrumental of a source file, kept beside its other cached media
 * (proxy, waveform) -- every clip cut from the same video, and every later
 * Remove Vocal on it, reuses the one separation. Named by the model that
 * made it: the CPU's single model is not kept as if it were the GPU's
 * four. */
function instrumentalCacheFile(model: string): string {
  return `no-vocals-${model}.m4a`
}

/** Set once the GPU separation has failed in this session: from then on
 * the CPU's result is what this computer makes, and is reused. */
let gpuSeparationFailed = false

/** htdemucs_ft is a bag of four models; Demucs runs them one after another
 * and prints a fresh tqdm bar (`NN%|...`) for each. Turning that into one
 * job-wide figure: the bar's own percent, plus one whole model's share for
 * every bar already completed -- detected as the percent dropping back
 * below where it was, which only happens when a new bar starts. */
const HTDEMUCS_FT_MODEL_COUNT = 4

export function makeDemucsProgressParser(report: (fraction: number) => void, barCount = HTDEMUCS_FT_MODEL_COUNT): (chunk: string) => void {
  let modelsDone = 0
  let lastPercent = -1
  return (chunk) => {
    // tqdm rewrites the line with a carriage return; every match in the
    // chunk is a fresh reading, so take the last one.
    const matches = chunk.match(/(\d{1,3})%\|/g)
    if (!matches) return
    const pct = Number(matches[matches.length - 1].replace('%|', ''))
    if (Number.isNaN(pct)) return
    if (pct < lastPercent && lastPercent >= 90) modelsDone = Math.min(barCount - 1, modelsDone + 1)
    lastPercent = pct
    report((modelsDone + pct / 100) / barCount)
  }
}

const SEPARATE_STALL_MS = 10 * 60_000

/** The Demucs model for a device: htdemucs_ft (a bag of four) on the GPU,
 * htdemucs (one model, ~4x quicker) on the CPU, where htdemucs_ft took the
 * better part of an hour on a long file and held every core. */
function demucsModelFor(device: string): string {
  return device === 'cpu' && existsSync(join(demucsModelRepo(), 'htdemucs.yaml')) ? 'htdemucs' : 'htdemucs_ft'
}

function demucsBarCount(model: string): number {
  return model === 'htdemucs_ft' ? HTDEMUCS_FT_MODEL_COUNT : 1
}

/** Demucs's environment: on the CPU, all cores but one -- the app keeps
 * one for itself. */
function demucsEnv(device: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: process.env.PYTHONPATH ?? '', PYTHONIOENCODING: 'utf-8' }
  if (device === 'cpu') {
    const threads = String(backgroundThreadCount())
    env.OMP_NUM_THREADS = threads
    env.MKL_NUM_THREADS = threads
  }
  return env
}

/** The filter that puts separated pieces back into one track: each
 * trimmed to its own stretch, the seams blended over a few milliseconds. */
function chunkJoinGraph(chunks: ReturnType<typeof planSeparationChunks>): { graph: string; finalLabel: string } {
  const trims = chunks.map((chunk, i) => `[${i}:a]atrim=start=${chunk.keepFrom.toFixed(3)}:end=${chunk.keepTo.toFixed(3)},asetpts=PTS-STARTPTS[p${i}]`)
  let last = 'p0'
  const fades: string[] = []
  for (let i = 1; i < chunks.length; i++) {
    const out = i === chunks.length - 1 ? 'mix' : `x${i}`
    fades.push(`[${last}][p${i}]acrossfade=d=0.05:c1=tri:c2=tri[${out}]`)
    last = out
  }
  return { graph: [...trims, ...fades].join(';'), finalLabel: chunks.length > 1 ? 'mix' : 'p0' }
}

/** A piece's length for this computer: a 5-minute piece peaked at 4.2 GB,
 * too much beside the app on 8 GB; 2 minutes keeps it near 2 GB. */
function separationChunkSeconds(): number {
  return totalmem() <= 12 * 1024 ** 3 ? 120 : 300
}

/** Real source separation: htdemucs_ft (Demucs v4, the fine-tuned four-
 * model bag -- the best-quality configuration Demucs ships) splits the
 * track into vocals and everything-else, and everything-else is what the
 * user gets: music, effects, ambience all intact, only the spoken voice
 * gone. Measured on this project's own source against the old karaoke
 * trick: the trick output pure silence (-240dB -- the file is dual-mono),
 * htdemucs took the speech band down 21dB while keeping the bed.
 *
 * `--segment 7` bounds VRAM so a 6GB card separates a long file in chunks
 * instead of running out part-way; a CUDA failure of any kind retries the
 * whole job on CPU (slower, but it finishes). Model weights come from
 * demucsModelRepo, so nothing is downloaded at run time. */
export async function removeVocalsWithDemucs(jobId: string, sourcePath: string, options: RemoveVocalsOptions): Promise<string> {
  const py = separatorPython(options.installDir)
  if (!existsSync(py)) throw new Error(`VoxCPM2 runtime not found at ${py} -- vocal separation runs from that Python. Set the install folder in Settings > Voice Engine.`)
  const repo = demucsModelRepo()
  if (!existsSync(join(repo, 'htdemucs_ft.yaml'))) throw new Error(`Separation model files are missing from ${repo}.`)
  const progress = options.onProgress ?? ((): void => undefined)
  const signal = options.signal
  const checkCanceled = (): void => {
    if (signal?.aborted) throw new VocalRemovalCanceledError()
  }

  // Already separated once: every clip of this video shares it -- the
  // four-model result always; the CPU's when the CPU is what runs here.
  const cacheDir = await ensureCacheDir(await cacheKeyForFile(sourcePath))
  const cpuOnly = options.device === 'cpu' || gpuSeparationFailed
  for (const model of cpuOnly ? ['htdemucs_ft', 'htdemucs'] : ['htdemucs_ft']) {
    const cached = join(cacheDir, instrumentalCacheFile(model))
    if (existsSync(cached)) {
      progress(100, 'Done')
      return cached
    }
  }

  if (!(await ensureDemucsInstalled(options.installDir))) {
    throw new Error('The `demucs` separator could not be installed into the VoxCPM2 runtime (this needs an internet connection the first time).')
  }
  checkCanceled()

  const { durationSeconds } = await probeMedia(sourcePath)
  const chunks = planSeparationChunks(durationSeconds, separationChunkSeconds())
  if (chunks.length === 0) throw new Error('This file has no sound to separate.')

  const workDir = await mkdtemp(join(tmpdir(), 'vocal-sep-'))
  // ffmpeg jobs are stopped through the job runner; Demucs through runPython.
  let ffmpegJob: string | null = null
  const onAbort = (): void => {
    if (ffmpegJob) cancelJob(ffmpegJob)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // Demucs wants plain PCM at its own 44.1k stereo; each piece is decoded
    // once, up front, so it never has to.
    const inputs: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      checkCanceled()
      progress(1 + Math.round((4 * i) / chunks.length), chunks.length > 1 ? `Decoding audio (${i + 1}/${chunks.length})` : 'Decoding audio')
      const chunkPath = join(workDir, `part_${String(i).padStart(3, '0')}.wav`)
      ffmpegJob = `${jobId}-decode-${i}`
      await runFfmpeg(ffmpegJob, ['-y', '-ss', chunks[i].start.toFixed(3), '-t', chunks[i].length.toFixed(3), '-i', sourcePath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', chunkPath])
      inputs.push(chunkPath)
    }
    checkCanceled()
    // Separation is ~5% -> ~95% of the wall time; the model load before the
    // first bar appears is the silent stretch at the start of it. All the
    // pieces go to ONE run, so the model loads once.
    progress(5, 'Loading separation model')

    const outRoot = join(workDir, 'out')
    const devices: string[] = options.device === 'cpu' ? ['cpu'] : ['cuda', 'cpu']
    let lastErr = ''
    let produced = false
    let stems: string[] = []
    let usedModel = 'htdemucs_ft'
    for (const device of devices) {
      // The GPU runs the four-model htdemucs_ft; the CPU (no GPU, or it
      // failed) the single htdemucs -- about four times quicker, nearly as
      // clean -- on all cores but one, so the app stays usable meanwhile.
      const model = demucsModelFor(device)
      stems = inputs.map((input) => join(outRoot, model, basename(input).replace(/\.wav$/, ''), 'no_vocals.wav'))
      const label = device === 'cpu' ? 'Separating (CPU)' : 'Separating'
      const parse = makeDemucsProgressParser((fraction) => progress(5 + Math.round(fraction * 88), label), demucsBarCount(model) * chunks.length)
      const { code, stderr } = await runPython(py, ['-m', 'demucs.separate', '--repo', repo, '-n', model, '--two-stems=vocals', '--segment', '7', '-o', outRoot, '-d', device, ...inputs], demucsEnv(device), SEPARATE_STALL_MS, parse, signal)
      checkCanceled()
      if (code === 0 && stems.every((stem) => existsSync(stem))) {
        produced = true
        usedModel = model
        break
      }
      if (device === 'cuda') gpuSeparationFailed = true
      lastErr = stderr.trim().split('\n').slice(-6).join('\n')
      // Only worth a CPU retry if the GPU attempt is what failed.
      if (device === 'cpu') break
    }
    if (!produced) throw new Error(`Vocal separation failed.\n${lastErr}`)

    // The pieces back into one track: each trimmed to its own stretch, the
    // seams blended over a few milliseconds, encoded once.
    progress(94, 'Joining')
    const outputPath = join(cacheDir, instrumentalCacheFile(usedModel))
    const { graph, finalLabel } = chunkJoinGraph(chunks)
    const tmpPath = join(cacheDir, `no-vocals.${Date.now().toString(36)}.tmp.m4a`)
    ffmpegJob = `${jobId}-encode`
    try {
      await runFfmpeg(ffmpegJob, ['-y', ...stems.flatMap((stem) => ['-i', stem]), '-filter_complex', graph, '-map', `[${finalLabel}]`, '-c:a', 'aac', '-b:a', '192k', tmpPath])
      checkCanceled()
      await rename(tmpPath, outputPath)
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined)
    }
    progress(100, 'Done')
    return outputPath
  } catch (err) {
    if (signal?.aborted) throw new VocalRemovalCanceledError()
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The speech of a video on its own -- the htdemucs_ft vocals stem, as the
 * 16 kHz mono WAV transcription reads -- written to `outputPath`. For Auto
 * SRT: measured on a real episode, Gemini answered "no speech" for whole
 * minutes of dialogue under a music bed (three times out of three), and
 * transcribed the very same minutes from the vocals stem (26 of 28, 25 of
 * 41 and 9 of 23 reference lines, where it had given none).
 *
 * GPU only: on the CPU the four-model bag runs slower than real time, far
 * too slow to put in front of every transcription. Returns false whenever
 * it can't run (no VoxCPM2 runtime, no demucs, no CUDA, a failure), and the
 * caller then transcribes the original mix as before. */
export async function separateSpeechForTranscription(
  jobId: string,
  sourcePath: string,
  outputPath: string,
  installDir: string,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void
): Promise<boolean> {
  const py = separatorPython(installDir)
  const repo = demucsModelRepo()
  if (!existsSync(py) || !existsSync(join(repo, 'htdemucs_ft.yaml'))) return false
  if (!(await ensureDemucsInstalled(installDir))) return false
  if (signal?.aborted) return false
  const workDir = await mkdtemp(join(tmpdir(), 'speech-sep-'))
  try {
    // In pieces, as Remove Vocal does: a whole episode in one go held its
    // full waveform and stems in memory (20 minutes took 9.8 GB).
    const { durationSeconds } = await probeMedia(sourcePath)
    const chunks = planSeparationChunks(durationSeconds, separationChunkSeconds())
    if (chunks.length === 0) return false
    const inputs: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) return false
      const chunkPath = join(workDir, `part_${String(i).padStart(3, '0')}.wav`)
      await runFfmpeg(`${jobId}-decode:${i}`, ['-y', '-ss', chunks[i].start.toFixed(3), '-t', chunks[i].length.toFixed(3), '-i', sourcePath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', chunkPath])
      inputs.push(chunkPath)
    }
    const outRoot = join(workDir, 'out')
    const args = ['-m', 'demucs.separate', '--repo', repo, '-n', 'htdemucs_ft', '--two-stems=vocals', '--segment', '7', '-o', outRoot, '-d', 'cuda', ...inputs]
    const env = { ...process.env, PYTHONPATH: process.env.PYTHONPATH ?? '', PYTHONIOENCODING: 'utf-8' }
    const parse = makeDemucsProgressParser((fraction) => onProgress?.(fraction), HTDEMUCS_FT_MODEL_COUNT * chunks.length)
    const { code } = await runPython(py, args, env, SEPARATE_STALL_MS, parse, signal)
    const stems = inputs.map((input) => join(outRoot, 'htdemucs_ft', basename(input).replace(/\.wav$/, ''), 'vocals.wav'))
    if (signal?.aborted || code !== 0 || !stems.every((stem) => existsSync(stem))) return false
    const { graph, finalLabel } = chunkJoinGraph(chunks)
    await runFfmpeg(`${jobId}-encode`, ['-y', ...stems.flatMap((stem) => ['-i', stem]), '-filter_complex', graph, '-map', `[${finalLabel}]`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath])
    return true
  } catch {
    return false
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Last-resort fallback (no VoxCPM2 runtime to run the separator from):
 * the karaoke trick, now only ever used on a source it can actually work
 * on -- the caller checks hasUsableStereoWidth first. */
export async function removeVocals(jobId: string, sourcePath: string): Promise<string> {
  const dir = join(getMediaCacheRoot(), 'generated')
  await mkdir(dir, { recursive: true })
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-instrumental.m4a`
  const outputPath = join(dir, safeName)

  await runFfmpeg(jobId, ['-y', '-i', sourcePath, '-vn', '-af', buildVocalRemovalFilter(), '-c:a', 'aac', '-b:a', '192k', outputPath])
  return outputPath
}

/** Just the voice of a short recording (a clone's reference): the Demucs
 * vocals stem, music and effects left out. The GPU first, then the CPU (a
 * 30-second clip is quick either way). Null when it cannot run. */
export async function isolateVoice(jobId: string, inputWav: string, installDir: string): Promise<string | null> {
  const py = separatorPython(installDir)
  const repo = demucsModelRepo()
  if (!existsSync(py) || !existsSync(join(repo, 'htdemucs_ft.yaml'))) return null
  if (!(await ensureDemucsInstalled(installDir))) return null
  const outRoot = join(dirname(inputWav), 'isolated')
  for (const device of ['cuda', 'cpu']) {
    const model = demucsModelFor(device)
    const vocals = join(outRoot, model, basename(inputWav).replace(/\.wav$/i, ''), 'vocals.wav')
    const { code } = await runPython(py, ['-m', 'demucs.separate', '--repo', repo, '-n', model, '--two-stems=vocals', '--segment', '7', '-o', outRoot, '-d', device, inputWav], demucsEnv(device), SEPARATE_STALL_MS)
    if (code === 0 && existsSync(vocals)) return vocals
  }
  void jobId
  return null
}
