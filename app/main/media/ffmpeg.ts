import { spawn } from 'child_process'
import ffmpegStaticPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { FfmpegAvailability } from '@shared/media'

export const ffmpegPath = ffmpegStaticPath
export const ffprobePath = ffprobeStatic.path

interface BinaryCheckResult {
  ok: boolean
  version?: string
  error?: string
}

function checkBinary(binPath: string): Promise<BinaryCheckResult> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(binPath, ['-version'])
      let out = ''
      proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
      proc.on('error', (err) => resolve({ ok: false, error: err.message }))
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, version: out.split('\n')[0]?.trim() })
        } else {
          resolve({ ok: false, error: `exited with code ${code}` })
        }
      })
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message })
    }
  })
}

export async function detectFfmpeg(): Promise<FfmpegAvailability> {
  const [ffmpegResult, ffprobeResult] = await Promise.all([
    checkBinary(ffmpegPath),
    checkBinary(ffprobePath)
  ])

  const errors: string[] = []
  if (!ffmpegResult.ok) errors.push(`ffmpeg: ${ffmpegResult.error}`)
  if (!ffprobeResult.ok) errors.push(`ffprobe: ${ffprobeResult.error}`)

  return {
    ffmpeg: ffmpegResult.ok,
    ffprobe: ffprobeResult.ok,
    ffmpegVersion: ffmpegResult.version,
    ffprobeVersion: ffprobeResult.version,
    error: errors.length > 0 ? errors.join('; ') : undefined
  }
}
