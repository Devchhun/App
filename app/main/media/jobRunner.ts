import { spawn, type ChildProcess } from 'child_process'
import { ffmpegPath } from './ffmpeg'
import { parseFfmpegProgressPercent } from './ffmpegProgress'
import { runInBackground } from './processPriority'

export class CanceledError extends Error {
  constructor() {
    super('Canceled')
    this.name = 'CanceledError'
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** No ffmpeg process in this pipeline should ever run silently forever --
 * without this, a hung/stalled encode (malformed input, a truly enormous
 * file, a stuck pipe) left the item's percent frozen with no automatic
 * recovery; only a user manually clicking Cancel (if they even noticed one
 * was hung) unstuck it. Reset on every stdout/stderr byte received, so a
 * merely SLOW job (large file, still genuinely making progress) is never
 * killed -- only one that's gone completely silent for this long. */
const STALL_TIMEOUT_MS = 90_000

/** `-movflags +faststart` rewrites the whole file once the encode is done,
 * printing nothing meanwhile: 25 s for 3.8 GB on a fast SSD, minutes on a
 * slow disk. The 90 s limit killed a finished 2 GB export there, at 100%. */
const FASTSTART_STALL_TIMEOUT_MS = 30 * 60_000

const activeJobs = new Map<string, ChildProcess>()
const canceledJobs = new Set<string>()

/** Kills whichever ffmpeg process is currently running under this job id,
 * if any -- and every job named `<jobId>:<part>` (an export's pieces run
 * side by side under its id). */
export function cancelJob(jobId: string): boolean {
  let any = false
  for (const [id, proc] of activeJobs) {
    if (id !== jobId && !id.startsWith(`${jobId}:`)) continue
    canceledJobs.add(id)
    proc.kill()
    any = true
  }
  return any
}

export interface RunFfmpegOptions {
  onProgress?: (percent: number) => void
  totalDurationSeconds?: number
  /** Collect raw stdout bytes instead of parsing `-progress` key=value lines (used for PCM decode). */
  captureStdout?: boolean
}

export interface RunFfmpegResult {
  stdout?: Buffer
}

export function runFfmpeg(jobId: string, args: string[], options: RunFfmpegOptions = {}): Promise<RunFfmpegResult> {
  return new Promise((resolve, reject) => {
    const proc = runInBackground(spawn(ffmpegPath, args))
    activeJobs.set(jobId, proc)

    const stdoutChunks: Buffer[] = []
    let stderr = ''
    // Only the LAST `out_time_ms=` line ever matters -- keeping the full
    // stdout history here and re-scanning it with a global regex on every
    // chunk was O(n^2) in the transcode's total output size, which visibly
    // slowed (and could look "stuck") on long files. A `-progress` line is
    // always on its own line, so the tail after the last newline is always
    // either empty or a partial next line -- safe to keep as the seed for
    // the next chunk instead of the entire buffer.
    let progressTail = ''
    let timedOut = false

    let stallTimer: ReturnType<typeof setTimeout>
    let stallMs = STALL_TIMEOUT_MS
    const armStall = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, stallMs)
    }
    armStall()

    proc.stdout.on('data', (chunk: Buffer) => {
      armStall()
      if (options.captureStdout) {
        stdoutChunks.push(chunk)
        return
      }
      const combined = progressTail + chunk.toString()
      const lines = combined.split('\n')
      progressTail = lines.pop() ?? ''
      if (options.onProgress && options.totalDurationSeconds) {
        const percent = parseFfmpegProgressPercent(lines, options.totalDurationSeconds)
        if (percent !== null) options.onProgress(percent)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes('Starting second pass')) stallMs = FASTSTART_STALL_TIMEOUT_MS
      armStall()
      stderr += text
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    proc.on('error', (err) => {
      clearTimeout(stallTimer)
      activeJobs.delete(jobId)
      canceledJobs.delete(jobId)
      reject(err)
    })

    proc.on('close', (code) => {
      clearTimeout(stallTimer)
      activeJobs.delete(jobId)
      const wasCanceled = canceledJobs.delete(jobId)
      if (timedOut) {
        reject(new TimeoutError(`ffmpeg made no progress for ${stallMs / 1000}s and was stopped`))
      } else if (wasCanceled) {
        reject(new CanceledError())
      } else if (code === 0) {
        resolve({ stdout: options.captureStdout ? Buffer.concat(stdoutChunks) : undefined })
      } else {
        reject(new Error(stderr.trim().split('\n').slice(-5).join('\n') || `ffmpeg exited with code ${code}`))
      }
    })
  })
}
