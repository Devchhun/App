import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash } from 'crypto'
import { once } from 'events'
import { existsSync } from 'fs'
import { rename, rm } from 'fs/promises'
import { basename, join } from 'path'
import { mixSpeechFrames, type SpeechRange } from '@shared/vocalRemoval'
import { cacheKeyForFile, ensureCacheDir } from './cache'
import { ffmpegPath } from './ffmpeg'
import { probeMedia } from './probe'
import { runInBackground } from './processPriority'
import { decodeAsSeparated, VocalRemovalCanceledError } from './vocalRemoval'

const SAMPLE_RATE = 48000
const BYTES_PER_FRAME = 4
const BLOCK_BYTES = 65536 * BYTES_PER_FRAME
/** A tenth of a second. */
const MOST_SHORT_BYTES = (SAMPLE_RATE / 10) * BYTES_PER_FRAME

/** Reads a process's raw output in blocks of an exact size (the mix needs
 * the two sounds sample for sample; pipes hand over whatever they have). */
function blockReader(proc: ChildProcessWithoutNullStreams): (bytes: number) => Promise<Buffer> {
  const stream = proc.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  let held: Buffer[] = []
  let heldBytes = 0
  let ended = false
  return async (bytes) => {
    while (heldBytes < bytes && !ended) {
      const next = await stream.next()
      if (next.done) ended = true
      else {
        held.push(next.value)
        heldBytes += next.value.length
      }
    }
    const all = Buffer.concat(held, heldBytes)
    const block = all.subarray(0, Math.min(bytes, all.length))
    const rest = all.subarray(block.length)
    held = rest.length > 0 ? [rest] : []
    heldBytes = rest.length
    return block
  }
}

/** A block as samples: a Buffer from a pipe may not start on a 2-byte
 * boundary, which an Int16Array needs. */
function samplesOf(block: Buffer, frames: number): Int16Array {
  const samples = new Int16Array(frames * 2)
  new Uint8Array(samples.buffer).set(block.subarray(0, frames * BYTES_PER_FRAME))
  return samples
}

/** Remove Vocal only where they speak: the file's own sound, with the
 * voice-free copy (`cleanPath`, the separator's result) only over `ranges`.
 * The music, the effects and every sound outside the lines stay exactly the
 * original instead of the separator's version of them. Same lines and same
 * separation: the same file back at once. */
export async function mixVocalsAtLines(
  sourcePath: string,
  cleanPath: string,
  ranges: SpeechRange[],
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<string> {
  const { signal, onProgress } = options
  const key = createHash('sha1').update(JSON.stringify([basename(cleanPath), ranges])).digest('hex').slice(0, 16)
  const cacheDir = await ensureCacheDir(await cacheKeyForFile(sourcePath))
  // "no-vocals-" first: Remove Vocal (all videos) tells a done video by it.
  const outputPath = join(cacheDir, `no-vocals-at-lines-${key}.m4a`)
  if (existsSync(outputPath)) return outputPath
  const { durationSeconds } = await probeMedia(sourcePath)
  if (!(durationSeconds > 0)) throw new Error('This file has no sound to work on.')
  const totalFrames = Math.round(durationSeconds * SAMPLE_RATE)
  const tmpPath = `${outputPath}.tmp.m4a`

  // The original as the separation read it, so the two line up sample by
  // sample whatever the file's times do. Half the job on a long film.
  const pieces = await decodeAsSeparated(`vocal-lines-${key}`, sourcePath, durationSeconds, { signal, onProgress: (fraction) => onProgress?.(fraction / 2) }).catch((err: unknown) => {
    if (signal?.aborted) throw new VocalRemovalCanceledError()
    throw new Error(`Could not read the sound of this video. ${err instanceof Error ? (err.message.trim().split('\n').pop() ?? '') : ''}`.trim())
  })
  const decode = (input: string[]): ChildProcessWithoutNullStreams =>
    runInBackground(spawn(ffmpegPath, ['-v', 'error', ...input, '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], { windowsHide: true })) as ChildProcessWithoutNullStreams
  // Both padded with silence to the file's length, so a few samples short
  // does not cut the end of the sound.
  const original = decode(pieces.args)
  const clean = decode(['-i', cleanPath, '-af', 'apad', '-t', durationSeconds.toFixed(3)])
  const encoder = runInBackground(
    spawn(ffmpegPath, ['-v', 'error', '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', '-', '-c:a', 'aac', '-b:a', '192k', tmpPath], { windowsHide: true })
  ) as ChildProcessWithoutNullStreams
  const processes = [original, clean, encoder]
  let errors = ''
  for (const proc of processes) {
    proc.stderr.on('data', (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-800)))
    proc.stdin.on('error', () => undefined)
  }
  const stop = (): void => {
    for (const proc of processes) {
      proc.kill()
      // Unread output would keep the process from ever counting as closed.
      proc.stdout.destroy()
    }
  }
  signal?.addEventListener('abort', stop, { once: true })
  const closed = (proc: ChildProcessWithoutNullStreams): Promise<number | null> => new Promise((resolve) => proc.once('close', resolve))
  const allClosed = Promise.all(processes.map(closed))
  try {
    const readOriginal = blockReader(original)
    const readClean = blockReader(clean)
    let frame = 0
    let cursor = 0
    for (;;) {
      // Never past the file's length, whatever a decoder still has.
      const wanted = Math.min(BLOCK_BYTES, (totalFrames - frame) * BYTES_PER_FRAME)
      if (wanted <= 0) break
      const [a, b] = await Promise.all([readOriginal(wanted), readClean(wanted)])
      if (signal?.aborted) throw new VocalRemovalCanceledError()
      const frames = Math.floor(a.length / BYTES_PER_FRAME)
      if (frames === 0) break
      // A few samples less at the very end is only rounding: the end stays
      // the original. Much less means that decoder failed, and half a sound
      // must not be kept as the result.
      if (a.length - b.length > MOST_SHORT_BYTES) throw new Error(`Could not read the separated sound. ${errors.trim().split('\n').pop() ?? ''}`.trim())
      const cleanFrames = Math.floor(b.length / BYTES_PER_FRAME)
      const mixed = samplesOf(a, frames)
      const voiceFree = samplesOf(b, cleanFrames)
      cursor = mixSpeechFrames(mixed.subarray(0, cleanFrames * 2), voiceFree, frame, SAMPLE_RATE, ranges, cursor)
      frame += frames
      if (!encoder.stdin.write(Buffer.from(mixed.buffer))) await Promise.race([once(encoder.stdin, 'drain'), closed(encoder)])
      onProgress?.(0.5 + Math.min(1, frame / totalFrames) / 2)
    }
    // A decoder may still be waiting to hand over the rest (the video's extra
    // second, or everything when the other could not open its file): it
    // would never close with nobody reading.
    for (const decoder of [original, clean]) {
      decoder.kill()
      decoder.stdout.destroy()
    }
    encoder.stdin.end()
    const [, , encoderCode] = await allClosed
    if (signal?.aborted) throw new VocalRemovalCanceledError()
    // The decoders were stopped above, so only the encoder's code says
    // anything; a video that could not be read gave no sound at all.
    if (encoderCode !== 0 || frame === 0) throw new Error(`Could not mix the sound: ${errors.trim().split('\n').pop() ?? 'ffmpeg failed'}`)
    await rename(tmpPath, outputPath)
    return outputPath
  } catch (err) {
    stop()
    // Windows cannot delete the half-made file while the encoder holds it.
    await allClosed
    if (signal?.aborted) throw new VocalRemovalCanceledError()
    throw err
  } finally {
    signal?.removeEventListener('abort', stop)
    await rm(tmpPath, { force: true }).catch(() => undefined)
    await rm(pieces.workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
