import { runFfmpeg } from './jobRunner'
import { PCM_SAMPLE_RATE, classifySpeaker, estimateF0FromPcm } from '@shared/speakerPitch'
import type { DetectSpeakerResult } from '@shared/narration'

export { classifySpeaker, estimateF0FromPcm, type F0Estimate } from '@shared/speakerPitch'

/** Extracts mono 16kHz PCM for exactly [startTime, endTime) of the ORIGINAL
 * video's own audio track (never the recorded take, never the subtitle
 * text) and runs shared/speakerPitch.ts's heuristic -- satisfies "must analyze actual
 * audio" honestly, without bundling or faking ML-grade voice classification. */
export async function detectSpeakerFromAudio(jobId: string, sourcePath: string, startTime: number, endTime: number): Promise<DetectSpeakerResult> {
  const duration = Math.max(0, endTime - startTime)
  if (duration <= 0) return { speaker: 'unknown' }

  const { stdout } = await runFfmpeg(
    jobId,
    ['-ss', String(startTime), '-i', sourcePath, '-t', String(duration), '-ac', '1', '-ar', String(PCM_SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
    { captureStdout: true }
  )
  const pcm = stdout ?? Buffer.alloc(0)
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  const { f0Hz, voicedRatio } = estimateF0FromPcm(samples)
  return classifySpeaker(f0Hz, voicedRatio)
}
