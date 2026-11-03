import { existsSync } from 'fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ReframeAnalysis, ReframeSample } from '@shared/reframe'
import { cacheKeyForFile, ensureCacheDir } from '../media/cache'
import { ffmpegPath } from '../media/ffmpeg'
import { probeMedia } from '../media/probe'
import { faceModelPath, runCastRunner } from './castScanService'

/** Frames looked at per second: enough to follow people, quick to run
 * (a six-minute episode in about fifteen seconds). */
const SAMPLES_PER_SECOND = 2
/** Bumped when what the runner writes changes. */
const CACHE_FILE = 'reframe-faces-v1.json'

/** Auto Reframe's look through one video file: where the faces are, a few
 * times a second, over the whole file -- kept beside the file's other
 * cached media, so every clip of it (a series cut into hundreds) and every
 * later run reuse it. */
export async function analyzeReframe(path: string, onFraction: (fraction: number) => void, signal: AbortSignal): Promise<ReframeAnalysis> {
  const cacheDir = await ensureCacheDir(await cacheKeyForFile(path))
  const cached = join(cacheDir, CACHE_FILE)
  if (existsSync(cached)) {
    try {
      return JSON.parse(await readFile(cached, 'utf-8')) as ReframeAnalysis
    } catch {
      // A broken copy: looked through again below.
    }
  }
  const meta = await probeMedia(path)
  if (!meta.hasVideo || !meta.width || !meta.height) throw new Error('This file has no picture to reframe.')
  // The small preview copy when there is one: the same picture, far quicker to decode.
  const proxy = join(cacheDir, 'proxy.mp4')
  const source = existsSync(proxy) ? proxy : path
  const workDir = await mkdtemp(join(tmpdir(), 'reframe-'))
  try {
    const jobPath = join(workDir, 'job.json')
    const outPath = join(workDir, 'out.json')
    const model = await faceModelPath(signal)
    await writeFile(jobPath, JSON.stringify({ model, ffmpeg: ffmpegPath, path: source, start: 0, end: meta.durationSeconds, fps: SAMPLES_PER_SECOND, out: outPath }), 'utf-8')
    await runCastRunner('reframe_runner.py', jobPath, onFraction, signal)
    const samples = (JSON.parse(await readFile(outPath, 'utf-8')) as { samples: ReframeSample[] }).samples
    const analysis: ReframeAnalysis = { width: meta.width, height: meta.height, samples }
    const tmp = `${cached}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(analysis), 'utf-8')
    await rename(tmp, cached)
    return analysis
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
