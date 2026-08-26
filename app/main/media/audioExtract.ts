import { join } from 'path'
import { rename, unlink } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'
import type { GenerateResult } from './thumbnail'

/**
 * 16kHz mono WAV, the format faster-whisper expects. Reuses the same cache
 * directory and job-runner infrastructure as the Phase B thumbnail/proxy/
 * waveform generation (keyed by the same content hash), generated lazily
 * only when a media file is actually sent for transcription.
 */
export async function extractTranscriptionAudio(
  jobId: string,
  sourcePath: string,
  cacheDir: string
): Promise<GenerateResult> {
  const outPath = join(cacheDir, 'audio-16k-mono.wav')
  if (await pathExists(outPath)) {
    return { outputPath: outPath, fromCache: true }
  }

  const tmpPath = join(cacheDir, `audio.${jobId}.tmp.wav`)
  try {
    await runFfmpeg(jobId, ['-y', '-i', sourcePath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmpPath])
    await rename(tmpPath, outPath)
    return { outputPath: outPath, fromCache: false }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
