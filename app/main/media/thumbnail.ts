import { join } from 'path'
import { rename, unlink } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'

export interface GenerateResult {
  outputPath: string
  fromCache: boolean
}

export async function generateThumbnail(
  jobId: string,
  sourcePath: string,
  cacheDir: string,
  durationSeconds: number
): Promise<GenerateResult> {
  const outPath = join(cacheDir, 'thumb.jpg')
  if (await pathExists(outPath)) {
    return { outputPath: outPath, fromCache: true }
  }

  const tmpPath = join(cacheDir, `thumb.${jobId}.tmp.jpg`)
  const seekTime = Math.min(Math.max(durationSeconds * 0.1, 0.1), Math.max(durationSeconds - 0.1, 0.1))

  try {
    await runFfmpeg(jobId, [
      '-y',
      '-ss',
      String(seekTime),
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:-2',
      tmpPath
    ])
    await rename(tmpPath, outPath)
    return { outputPath: outPath, fromCache: false }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
