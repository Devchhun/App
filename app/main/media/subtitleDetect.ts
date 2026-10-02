import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpeg'
import { probeMedia } from './probe'
import { findSubtitleBand, pickSampleTimes, type DetectedBand } from '@shared/subtitleDetect'

/** Width the frames are read at: enough for subtitle strokes, small enough
 * that 24 frames take a few seconds even from a 4K file. */
const SAMPLE_WIDTH = 384

function grayFrame(videoPath: string, seconds: number, width: number, height: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, seconds)), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${width}:${height},format=gray`, '-f', 'rawvideo', '-'])
    const chunks: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      const buf = Buffer.concat(chunks)
      resolve(buf.length === width * height ? new Uint8Array(buf) : null)
    })
  })
}

/** Where `videoPath`'s own burned-in subtitles are (see shared/subtitleDetect.ts),
 * looking at the frames at `lineMiddles` (seconds in the file) -- or null
 * when nothing subtitle-like stands out. */
export async function detectBurnedSubtitles(videoPath: string, lineMiddles: number[]): Promise<DetectedBand | null> {
  const meta = await probeMedia(videoPath)
  const w = meta.width ?? 1920
  const h = meta.height ?? 1080
  const duration = meta.durationSeconds ?? 0
  const height = Math.max(8, Math.round((SAMPLE_WIDTH * h) / w / 2) * 2)
  let times = pickSampleTimes(lineMiddles.filter((t) => !duration || t < duration))
  // No subtitle times to go by: look across the whole file.
  if (times.length < 6 && duration > 0) times = Array.from({ length: 24 }, (_, i) => (duration * (i + 0.5)) / 24)
  const frames: Uint8Array[] = []
  for (const t of times) {
    const frame = await grayFrame(videoPath, t, SAMPLE_WIDTH, height)
    if (frame) frames.push(frame)
  }
  return findSubtitleBand(frames, SAMPLE_WIDTH, height)
}
