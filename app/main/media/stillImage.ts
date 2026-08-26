import { join } from 'path'
import { rename, unlink } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'
import type { GenerateResult } from './thumbnail'

/** How long an imported still image plays for before the pipeline has to
 * treat it like any other clip -- long enough to be useful on the timeline,
 * short enough to encode/cache quickly. The user can trim the resulting clip
 * shorter (or duplicate it) like any other media. */
export const STILL_IMAGE_VIDEO_DURATION_SECONDS = 8

/** Synthesizes a silent, fixed-duration H.264 video from a still image so
 * the rest of the media pipeline (probe/thumbnail/proxy/playback/export)
 * never needs to special-case images -- it only ever deals with real video
 * files with an audio stream. Cached alongside the thumbnail/proxy under the
 * same content-addressed cache directory as the source image. */
export async function synthesizeVideoFromImage(jobId: string, imagePath: string, cacheDir: string): Promise<GenerateResult> {
  const outPath = join(cacheDir, 'source.mp4')
  if (await pathExists(outPath)) {
    return { outputPath: outPath, fromCache: true }
  }

  const tmpPath = join(cacheDir, `source.${jobId}.tmp.mp4`)

  try {
    await runFfmpeg(jobId, [
      '-y',
      '-loop',
      '1',
      '-i',
      imagePath,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-t',
      String(STILL_IMAGE_VIDEO_DURATION_SECONDS),
      // Even dimensions are required by yuv420p -- rounds down to the
      // nearest even pixel without otherwise resizing the image.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-shortest',
      tmpPath
    ])
    await rename(tmpPath, outPath)
    return { outputPath: outPath, fromCache: false }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
