import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fitCommandLine } from './ffmpegArgs'
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

/** An ffmpeg line that says what went wrong -- not the encoder statistics
 * it prints on the way out ("[libx264 @ …] kb/s:…", "Qavg: …"). */
const PROBLEM_LINE = /error|invalid|fail|cannot|could not|couldn't|unable|no such|not supported|unsupported|denied|too large|exceed|corrupt|mismatch|not enough|out of memory|impossible|backward|non monoton|no space|enospc|not enough space/i
const STATS_LINE = /kb\/s:|Qavg|frame [IPB]:|mb [IPB] |consecutive B-frames|coded y,uv|i16 v,h|i8 v,h|i4 v,h|i8c dc|Weighted P-Frames|ref [PB] L|8x8 transform|direct mvs|SSIM|PSNR/

/** The message for a failed run: the lines that name the problem -- kept
 * through the whole run, where a long encode's closing statistics used to
 * push them out of the message ("Export failed: [libx264] i8c dc,h,v,p …
 * Qavg … Conversion failed!" said nothing) -- then the last line. */
export function ffmpegFailureMessage(problemLines: string[], stderr: string, code: number | null): string {
  const tail = stderr
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !STATS_LINE.test(line))
    .slice(-1)
  const lines = [...new Set([...problemLines.slice(-4), ...tail])]
  return lines.join('\n') || `ffmpeg exited with code ${code}`
}

export function runFfmpeg(jobId: string, args: string[], options: RunFfmpegOptions = {}): Promise<RunFfmpegResult> {
  return new Promise((resolve, reject) => {
    // A filter graph too long for a Windows command line is read from a
    // file (see ffmpegArgs.ts), removed again when ffmpeg is done.
    let scriptDir: string | null = null
    const fitted = fitCommandLine(ffmpegPath, args, (graph) => {
      scriptDir ??= mkdtempSync(join(tmpdir(), 'ffmpeg-graph-'))
      const file = join(scriptDir, `graph-${Math.random().toString(36).slice(2)}.txt`)
      writeFileSync(file, graph, 'utf8')
      return file
    })
    const cleanUp = (): void => {
      if (scriptDir) rmSync(scriptDir, { recursive: true, force: true })
    }
    const proc = runInBackground(spawn(ffmpegPath, fitted))
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
    const problemLines: string[] = []
    let stderrTail = ''

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
      const lines = (stderrTail + text).split(/\r?\n|\r/)
      stderrTail = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed && PROBLEM_LINE.test(trimmed) && !STATS_LINE.test(trimmed)) {
          problemLines.push(trimmed.slice(0, 400))
          if (problemLines.length > 20) problemLines.shift()
        }
      }
    })

    proc.on('error', (err) => {
      clearTimeout(stallTimer)
      cleanUp()
      activeJobs.delete(jobId)
      canceledJobs.delete(jobId)
      reject(err)
    })

    proc.on('close', (code) => {
      clearTimeout(stallTimer)
      cleanUp()
      activeJobs.delete(jobId)
      const wasCanceled = canceledJobs.delete(jobId)
      if (timedOut) {
        reject(new TimeoutError(`ffmpeg made no progress for ${stallMs / 1000}s and was stopped`))
      } else if (wasCanceled) {
        reject(new CanceledError())
      } else if (code === 0) {
        resolve({ stdout: options.captureStdout ? Buffer.concat(stdoutChunks) : undefined })
      } else {
        reject(new Error(ffmpegFailureMessage(problemLines, stderr, code)))
      }
    })
  })
}
