import { spawn, type ChildProcess } from 'child_process'
import { ffmpegPath } from './ffmpeg'

export class CanceledError extends Error {
  constructor() {
    super('Canceled')
    this.name = 'CanceledError'
  }
}

const activeJobs = new Map<string, ChildProcess>()
const canceledJobs = new Set<string>()

/** Kills whichever ffmpeg process is currently running under this job id, if any. */
export function cancelJob(jobId: string): boolean {
  const proc = activeJobs.get(jobId)
  if (!proc) return false
  canceledJobs.add(jobId)
  proc.kill()
  return true
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
    const proc = spawn(ffmpegPath, args)
    activeJobs.set(jobId, proc)

    const stdoutChunks: Buffer[] = []
    let stderr = ''
    let progressBuffer = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      if (options.captureStdout) {
        stdoutChunks.push(chunk)
        return
      }
      progressBuffer += chunk.toString()
      if (options.onProgress && options.totalDurationSeconds) {
        const matches = progressBuffer.match(/out_time_ms=(\d+)/g)
        if (matches && matches.length > 0) {
          const last = matches[matches.length - 1]
          // ffmpeg's `-progress` out_time_ms field is actually in microseconds.
          const outTimeMicros = Number(last.split('=')[1])
          const percent = Math.min(100, (outTimeMicros / 1_000_000 / options.totalDurationSeconds) * 100)
          options.onProgress(percent)
        }
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    proc.on('error', (err) => {
      activeJobs.delete(jobId)
      canceledJobs.delete(jobId)
      reject(err)
    })

    proc.on('close', (code) => {
      activeJobs.delete(jobId)
      const wasCanceled = canceledJobs.delete(jobId)
      if (wasCanceled) {
        reject(new CanceledError())
      } else if (code === 0) {
        resolve({ stdout: options.captureStdout ? Buffer.concat(stdoutChunks) : undefined })
      } else {
        reject(new Error(stderr.trim().split('\n').slice(-5).join('\n') || `ffmpeg exited with code ${code}`))
      }
    })
  })
}
