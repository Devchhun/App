import { spawn } from 'child_process'
import { ffprobePath } from './ffmpeg'
import type { MediaMetadata } from '@shared/media'

interface FfprobeStream {
  codec_type: string
  codec_name: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
}

interface FfprobeFormat {
  duration?: string
  format_name?: string
  size?: string
}

interface FfprobeOutput {
  streams: FfprobeStream[]
  format: FfprobeFormat
}

function parseFrameRate(rate?: string): number | undefined {
  if (!rate) return undefined
  const [num, den] = rate.split('/').map(Number)
  if (!den) return num || undefined
  return den === 0 ? undefined : num / den
}

function runAndCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${bin} exited with code ${code}`))
    })
  })
}

export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]
  const output = await runAndCapture(ffprobePath, args)
  const parsed: FfprobeOutput = JSON.parse(output)

  const videoStream = parsed.streams.find((s) => s.codec_type === 'video')
  const audioStream = parsed.streams.find((s) => s.codec_type === 'audio')

  if (!videoStream && !audioStream) {
    throw new Error('No audio or video streams found in file')
  }

  return {
    durationSeconds: Number(parsed.format.duration ?? 0),
    width: videoStream?.width,
    height: videoStream?.height,
    frameRate: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    containerFormat: parsed.format.format_name ?? 'unknown',
    fileSizeBytes: Number(parsed.format.size ?? 0)
  }
}
