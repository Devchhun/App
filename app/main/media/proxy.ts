import { join, dirname } from 'path'
import { spawn } from 'child_process'
import { readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { CanceledError, runFfmpeg, TimeoutError } from './jobRunner'
import { detectProxyEncodePaths, proxyEncodeArgs, proxyEncodeSlots } from './hwAccel'
import { pathExists } from './cache'
import { ffmpegPath } from './ffmpeg'
import type { GenerateResult } from './thumbnail'

/** Beside a proxy that passed verifyProxyFile: its size and time, so a
 * proxy replaced later is checked again. */
const VERIFIED_MARKER = 'proxy.verified'
/** A check that runs longer than this is given up on -- and the proxy
 * kept: never throw away a file that could not be judged. */
const VERIFY_TIMEOUT_MS = 5 * 60_000

/** Encodes in flight, by proxy path. Opening a project resumes unfinished
 * media (ipc/media.ts's rehydrate) with the SAME media id while the first
 * encode can still be running in this process -- a 90-minute video takes
 * most of an hour -- and two ffmpeg processes writing one temp file made a
 * proxy whose index no longer matched its data: Chromium stopped decoding
 * it partway ("Preview unavailable" on every clip after that point, the
 * player dead past it). A second caller now waits for the first encode. */
const inflight = new Map<string, { promise: Promise<GenerateResult>; listeners: Set<(percent: number) => void> }>()

/** Whether a finished proxy is intact: every packet read through once
 * without decoding (a few seconds even for a feature-length file). A
 * damaged file reports errors such as "Invalid NAL unit size"; a sound one
 * reports nothing. */
export function verifyProxyFile(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-map', '0', '-c', 'copy', '-f', 'null', '-'])
    const timer = setTimeout(() => {
      proc.kill()
      finish(true)
    }, VERIFY_TIMEOUT_MS)
    proc.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().trim()) {
        proc.kill()
        finish(false)
      }
    })
    // ffmpeg missing or unstartable: nothing was judged.
    proc.on('error', () => finish(true))
    proc.on('close', (code) => finish(code === 0))
  })
}

async function markerMatches(proxyPath: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(dirname(proxyPath), VERIFIED_MARKER), 'utf-8')) as { size?: number; mtimeMs?: number }
    const info = await stat(proxyPath)
    return marker.size === info.size && marker.mtimeMs === info.mtimeMs
  } catch {
    return false
  }
}

async function writeMarker(proxyPath: string): Promise<void> {
  try {
    const info = await stat(proxyPath)
    await writeFile(join(dirname(proxyPath), VERIFIED_MARKER), JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs }))
  } catch {
    // Only saves checking again next time.
  }
}

/** A proxy already on disk: 'ok' (checked now or before), 'missing', or
 * 'bad' -- a damaged one is deleted so it is made again. */
export async function checkCachedProxy(proxyPath: string): Promise<'ok' | 'missing' | 'bad'> {
  if (inflight.has(proxyPath)) return 'ok'
  if (!(await pathExists(proxyPath))) return 'missing'
  if (await markerMatches(proxyPath)) return 'ok'
  if (await verifyProxyFile(proxyPath)) {
    await writeMarker(proxyPath)
    return 'ok'
  }
  console.warn(`[media] damaged proxy discarded: ${proxyPath}`)
  await unlink(proxyPath).catch(() => {})
  await unlink(join(dirname(proxyPath), VERIFIED_MARKER)).catch(() => {})
  return 'bad'
}

/** Proxies being encoded right now, and those waiting for a turn. */
let encodesRunning = 0
const encodesWaiting: (() => void)[] = []

function acquireEncodeSlot(slots: number): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      encodesRunning++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        encodesRunning--
        encodesWaiting.shift()?.()
      })
    }
    if (encodesRunning < slots) grant()
    else encodesWaiting.push(grant)
  })
}

/** Temp files of encodes that never finished (the app closed mid-way) --
 * none is in flight for this folder, so all of them are leftovers. */
async function removeLeftoverTemps(cacheDir: string): Promise<void> {
  try {
    for (const name of await readdir(cacheDir)) {
      if (/^proxy\..+\.tmp\.mp4$/.test(name)) await unlink(join(cacheDir, name)).catch(() => {})
    }
  } catch {
    // Nothing to tidy.
  }
}

export async function generateVideoProxy(
  jobId: string,
  sourcePath: string,
  cacheDir: string,
  durationSeconds: number,
  onProgress?: (percent: number) => void
): Promise<GenerateResult> {
  const outPath = join(cacheDir, 'proxy.mp4')
  const running = inflight.get(outPath)
  if (running) {
    if (onProgress) running.listeners.add(onProgress)
    return running.promise
  }
  if ((await checkCachedProxy(outPath)) === 'ok') {
    onProgress?.(100)
    return { outputPath: outPath, fromCache: true }
  }
  // Checked again: another caller may have started while this one waited.
  const started = inflight.get(outPath)
  if (started) {
    if (onProgress) started.listeners.add(onProgress)
    return started.promise
  }

  const listeners = new Set<(percent: number) => void>(onProgress ? [onProgress] : [])
  const report = (percent: number): void => {
    for (const listener of listeners) listener(percent)
  }
  const promise = (async (): Promise<GenerateResult> => {
    await removeLeftoverTemps(cacheDir)
    // The best way this computer has (shared/hwAccel: a GPU encoder, the
    // CPU last), each next one tried if a path fails or makes a damaged
    // file -- a GPU that cannot take one particular source still ends in a
    // proxy. Few at a time, so several imports never pin a small CPU.
    const paths = await detectProxyEncodePaths()
    const release = await acquireEncodeSlot(proxyEncodeSlots(paths))
    try {
      let lastError: unknown = null
      for (const path of paths) {
        const tmpPath = join(cacheDir, `proxy.${jobId}.${Date.now().toString(36)}.tmp.mp4`)
        const { input, output } = proxyEncodeArgs(path)
        try {
          await runFfmpeg(
            jobId,
            ['-y', ...input, '-i', sourcePath, ...output, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmpPath],
            { onProgress: report, totalDurationSeconds: durationSeconds }
          )
          if (!(await verifyProxyFile(tmpPath))) {
            await unlink(tmpPath).catch(() => {})
            lastError = new Error(`The preview copy came out damaged (${path}).`)
            continue
          }
          await rename(tmpPath, outPath)
          await writeMarker(outPath)
          return { outputPath: outPath, fromCache: false }
        } catch (err) {
          await unlink(tmpPath).catch(() => {})
          // Canceled or stalled: stop, do not try the next way.
          if (err instanceof CanceledError || err instanceof TimeoutError) throw err
          lastError = err
          console.warn(`[media] proxy via ${path} failed, trying the next way: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
        }
      }
      throw lastError instanceof Error ? lastError : new Error('The preview copy (proxy) could not be made -- the original file is used instead.')
    } finally {
      release()
    }
  })()
  inflight.set(outPath, { promise, listeners })
  try {
    return await promise
  } finally {
    inflight.delete(outPath)
  }
}
