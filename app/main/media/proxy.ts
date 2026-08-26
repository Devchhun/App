import { join } from 'path'
import { rename, unlink } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'
import type { GenerateResult } from './thumbnail'

export async function generateVideoProxy(
  jobId: string,
  sourcePath: string,
  cacheDir: string,
  durationSeconds: number,
  onProgress?: (percent: number) => void
): Promise<GenerateResult> {
  const outPath = join(cacheDir, 'proxy.mp4')
  if (await pathExists(outPath)) {
    onProgress?.(100)
    return { outputPath: outPath, fromCache: true }
  }

  const tmpPath = join(cacheDir, `proxy.${jobId}.tmp.mp4`)

  try {
    await runFfmpeg(
      jobId,
      [
        '-y',
        '-i',
        sourcePath,
        '-vf',
        'scale=-2:480',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        tmpPath
      ],
      { onProgress, totalDurationSeconds: durationSeconds }
    )
    await rename(tmpPath, outPath)
    return { outputPath: outPath, fromCache: false }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
