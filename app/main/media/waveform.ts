import { join } from 'path'
import { writeFile, readFile } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'
import type { WaveformData } from '@shared/media'

const TARGET_SAMPLE_RATE = 8000
const BUCKET_COUNT = 1200

export async function generateWaveform(jobId: string, sourcePath: string, cacheDir: string): Promise<WaveformData> {
  const outPath = join(cacheDir, 'waveform.json')
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
  const bucketSize = Math.max(1, Math.floor(samples.length / BUCKET_COUNT))
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
