import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import { runFfmpeg } from './jobRunner'
import { ffmpegPath } from './ffmpeg'
import { getMediaCacheRoot } from './cache'
import { probeAudioChannels } from './probe'
import type { VoxCpmDevice } from '@shared/dubbing'

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
  onStderr?: (chunk: string) => void
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, args, { env })
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
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(stallTimer)
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
}

/** htdemucs_ft is a bag of four models; Demucs runs them one after another
 * and prints a fresh tqdm bar (`NN%|...`) for each. Turning that into one
 * job-wide figure: the bar's own percent, plus one whole model's share for
 * every bar already completed -- detected as the percent dropping back
 * below where it was, which only happens when a new bar starts. */
const HTDEMUCS_FT_MODEL_COUNT = 4

export function makeDemucsProgressParser(report: (fraction: number) => void): (chunk: string) => void {
  let modelsDone = 0
  let lastPercent = -1
  return (chunk) => {
    // tqdm rewrites the line with a carriage return; every match in the
    // chunk is a fresh reading, so take the last one.
    const matches = chunk.match(/(\d{1,3})%\|/g)
    if (!matches) return
    const pct = Number(matches[matches.length - 1].replace('%|', ''))
    if (Number.isNaN(pct)) return
    if (pct < lastPercent && lastPercent >= 90) modelsDone = Math.min(HTDEMUCS_FT_MODEL_COUNT - 1, modelsDone + 1)
    lastPercent = pct
    report((modelsDone + pct / 100) / HTDEMUCS_FT_MODEL_COUNT)
  }
}

const SEPARATE_STALL_MS = 10 * 60_000

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
  if (!(await ensureDemucsInstalled(options.installDir))) {
    throw new Error('The `demucs` separator could not be installed into the VoxCPM2 runtime (this needs an internet connection the first time).')
  }

  const progress = options.onProgress ?? ((): void => undefined)
  const workDir = await mkdtemp(join(tmpdir(), 'vocal-sep-'))
  try {
    // Demucs wants plain PCM at its own 44.1k stereo; decode whatever the
    // source is once, up front, so it never has to.
    progress(2, 'Decoding audio')
    const inputWav = join(workDir, 'input.wav')
    await runFfmpeg(jobId, ['-y', '-i', sourcePath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', inputWav])
    // Separation is ~5% -> ~95% of the wall time; the model load before the
    // first bar appears is the silent stretch at the start of it.
    progress(5, 'Loading separation model')

    const outRoot = join(workDir, 'out')
    const baseArgs = ['-m', 'demucs.separate', '--repo', repo, '-n', 'htdemucs_ft', '--two-stems=vocals', '--segment', '7', '-o', outRoot, inputWav]
    const env = { ...process.env, PYTHONPATH: process.env.PYTHONPATH ?? '', PYTHONIOENCODING: 'utf-8' }

    const devices: string[] = options.device === 'cpu' ? ['cpu'] : ['cuda', 'cpu']
    let lastErr = ''
    let produced: string | null = null
    for (const device of devices) {
      const parse = makeDemucsProgressParser((fraction) => progress(5 + Math.round(fraction * 90), device === 'cpu' ? 'Separating (CPU)' : 'Separating'))
      const { code, stderr } = await runPython(py, [...baseArgs, '-d', device], env, SEPARATE_STALL_MS, parse)
      const candidate = join(outRoot, 'htdemucs_ft', 'input', 'no_vocals.wav')
      if (code === 0 && existsSync(candidate)) {
        produced = candidate
        break
      }
      lastErr = stderr.trim().split('\n').slice(-6).join('\n')
      // Only worth a CPU retry if the GPU attempt is what failed.
      if (device === 'cpu') break
    }
    if (!produced) throw new Error(`Vocal separation failed.\n${lastErr}`)

    progress(96, 'Encoding')
    const dir = join(getMediaCacheRoot(), 'generated')
    await mkdir(dir, { recursive: true })
    const outputPath = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-no-vocals.m4a`)
    await runFfmpeg(`${jobId}-encode`, ['-y', '-i', produced, '-c:a', 'aac', '-b:a', '192k', outputPath])
    progress(100, 'Done')
    return outputPath
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
