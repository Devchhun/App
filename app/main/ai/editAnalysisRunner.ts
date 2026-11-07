import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath } from '../media/ffmpeg'
import { runCastRunner } from './castScanService'
import type { RawAnalysisResult, SegmentMatch } from '@shared/aiEditing'

/** A few frames a second is plenty to learn pacing and scene choices, and
 * keeps a long pair's analysis quick. */
const ANALYSIS_FPS = 4

/**
 * Run the reverse-editing analysis on one original/edited pair. Spawns
 * `edit_analysis_runner.py` (bundled Python + the app's ffmpeg), which writes
 * its result to a temp file; we read it back and give every match a stable id.
 * `onFraction` reports 0..1; `signal` cancels.
 */
export async function analyzeVideoPair(
  originalPath: string,
  editedPath: string,
  onFraction: (fraction: number) => void,
  signal: AbortSignal,
): Promise<RawAnalysisResult & { matches: SegmentMatch[] }> {
  const work = await mkdtemp(join(tmpdir(), 'ai-edit-'))
  const jobPath = join(work, 'job.json')
  const outPath = join(work, 'result.json')
  try {
    await writeFile(
      jobPath,
      JSON.stringify({ ffmpeg: ffmpegPath, originalPath, editedPath, out: outPath, fps: ANALYSIS_FPS }),
      'utf-8',
    )
    await runCastRunner('edit_analysis_runner.py', jobPath, onFraction, signal)
    const raw = JSON.parse(await readFile(outPath, 'utf-8')) as RawAnalysisResult
    const matches: SegmentMatch[] = raw.matches.map((m, i) => ({ ...m, id: `m${i}` }))
    return { ...raw, matches }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Scene detection on one video (the new source footage an auto-edit arranges).
 * Same runner, no edited video to match against. */
export async function detectScenes(
  videoPath: string,
  onFraction: (fraction: number) => void,
  signal: AbortSignal,
): Promise<RawAnalysisResult['sourceShots']> {
  const work = await mkdtemp(join(tmpdir(), 'ai-scenes-'))
  const jobPath = join(work, 'job.json')
  const outPath = join(work, 'result.json')
  try {
    await writeFile(jobPath, JSON.stringify({ ffmpeg: ffmpegPath, originalPath: videoPath, editedPath: '', out: outPath, fps: ANALYSIS_FPS }), 'utf-8')
    await runCastRunner('edit_analysis_runner.py', jobPath, onFraction, signal)
    const raw = JSON.parse(await readFile(outPath, 'utf-8')) as RawAnalysisResult
    return raw.sourceShots
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
