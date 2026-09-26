import { join } from 'path'
import { writeFile, readFile } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'
import type { WaveformData } from '@shared/media'

const TARGET_SAMPLE_RATE = 8000
/** Buckets per second of audio -- 40 (25 ms each) is finer than any zoom
 * the Timeline offers, so a clip zoomed right in still shows real
 * detail instead of the 1.7 s plateaus a fixed 1,200-per-file count gave
 * a half-hour recording. Capped so a many-hour file stays a few MB. */
const BUCKETS_PER_SECOND = 40
const MAX_BUCKETS = 400_000
/** Cache file name, versioned: the resolution change above must not be
 * served from the old per-file-count cache. */
export const WAVEFORM_CACHE_FILE = 'waveform-v2.json'

export async function generateWaveform(jobId: string, sourcePath: string, cacheDir: string): Promise<WaveformData> {
  const outPath = join(cacheDir, WAVEFORM_CACHE_FILE)
  if (await pathExists(outPath)) {
    return JSON.parse(await readFile(outPath, 'utf-8')) as WaveformData
  }

  const { stdout } = await runFfmpeg(
    jobId,
    ['-i', sourcePath, '-ac', '1', '-ar', String(TARGET_SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
    { captureStdout: true }
  )
  const pcm = stdout ?? Buffer.alloc(0)
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  const wantedBuckets = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(samples.length / TARGET_SAMPLE_RATE) * BUCKETS_PER_SECOND))
  const bucketSize = Math.max(1, Math.floor(samples.length / wantedBuckets))
  const peaks: number[] = []

  for (let i = 0; i < samples.length; i += bucketSize) {
    let min = 0
    let max = 0
    const end = Math.min(i + bucketSize, samples.length)
    for (let j = i; j < end; j++) {
      const v = samples[j] / 32768
      if (v < min) min = v
      if (v > max) max = v
    }
    peaks.push(min, max)
  }

  const data: WaveformData = {
    peaks,
    sampleRate: TARGET_SAMPLE_RATE,
    bucketCount: peaks.length / 2
  }
  await writeFile(outPath, JSON.stringify(data))
  return data
}
