import { spawn } from 'child_process'
import ffmpegStaticPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { FfmpegAvailability } from '@shared/media'

/** ffmpeg-static/ffprobe-static resolve their own binary path relative to
 * their own module location, which inside a packaged (asar) app is a path
 * string like `...\resources\app.asar\node_modules\ffmpeg-static\ffmpeg.exe`.
 * That file is real on disk -- electron-builder.yml's `asarUnpack` puts it at
 * the `app.asar.unpacked` sibling directory instead -- but a virtual path
 * *inside* app.asar can never be spawned as a child process (asar's fs
 * virtualization makes packed files readable, not executable); Electron's
 * own docs call this out as the standard fix for exactly this class of
 * native-binary-inside-asar bug. Only rewrites when the substring is
 * actually present, so this is a no-op in dev (unpackaged, no asar in the path at all). */
function unpackAsarPath(p: string): string {
  return p.replace('app.asar', 'app.asar.unpacked')
}

export const ffmpegPath = unpackAsarPath(ffmpegStaticPath)
export const ffprobePath = unpackAsarPath(ffprobeStatic.path)

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
