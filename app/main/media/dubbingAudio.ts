import { mkdir } from 'fs/promises'
import { join } from 'path'
import { runFfmpeg } from './jobRunner'
import { getMediaCacheRoot } from './cache'

/** AI Dubber's "Generate Dubbing" placeholder step -- see this feature's own
 * plan for why: there is no text-to-speech/voice-generation engine anywhere
 * in this codebase, so "generating" a dubbed line today means copying that
 * subtitle's own [startTime, endTime) slice out of the ORIGINAL video's own
 * audio onto the new DUB1 track, clearly labeled as a placeholder rather
 * than a synthesized voice. Swapping in a real TTS provider later only
 * means replacing this one function's body.
 *
 * Writes into the SAME `generated` cache directory MEDIA_IPC.saveGeneratedFile
 * already uses (app/main/ipc/media.ts) -- unlike that handler (which exists
 * to receive bytes a renderer already has in memory, e.g. a MediaRecorder
 * blob), this extraction happens entirely in the main process against a
 * real source file path, so there's nothing to round-trip through the
 * renderer first; the returned path is ready to hand straight to
 * `importPaths`, exactly like `saveGeneratedFile`'s own callers do. */
export async function extractDubPlaceholderClip(jobId: string, sourcePath: string, startTime: number, endTime: number): Promise<string> {
  const duration = Math.max(0, endTime - startTime)
  const dir = join(getMediaCacheRoot(), 'generated')
  await mkdir(dir, { recursive: true })
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-dub-placeholder.m4a`
  const outputPath = join(dir, safeName)

  await runFfmpeg(jobId, ['-y', '-ss', String(startTime), '-i', sourcePath, '-t', String(duration), '-vn', '-c:a', 'aac', outputPath])
  return outputPath
}
