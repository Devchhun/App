import { spawn } from 'child_process'
import { join } from 'path'
import { rename, unlink, mkdir } from 'fs/promises'
import { ffmpegPath } from './ffmpeg'
import { runFfmpeg } from './jobRunner'
import { pathExists } from './cache'
import {
  activeExportClips,
  buildExportFilterGraph,
  computeExportDurationSeconds,
  resolveOutputDimensions,
  EXPORT_CODEC_ENCODER,
  type ExportOptions,
  type ExportCodec,
  type ResolvedExportClip
} from '@shared/export'
import type { ProjectSequence } from '@shared/project'

export class ExportError extends Error {
  readonly kind: 'no-content' | 'codec-unavailable' | 'ffmpeg-failed' | 'canceled' | 'io' | 'unknown'
  constructor(kind: ExportError['kind'], message: string) {
    super(message)
    this.name = 'ExportError'
    this.kind = kind
  }
}

export interface ExportMediaInfo {
  originalPath: string
}

let cachedAvailableEncoders: Set<string> | null = null

/** Runs `ffmpeg -encoders` once and caches which of the codecs this app
 * offers are actually built into the bundled binary -- verified, not
 * assumed (a static ffmpeg build's included encoders vary by version). */
export function checkEncoderAvailability(): Promise<Set<string>> {
  if (cachedAvailableEncoders) return Promise.resolve(cachedAvailableEncoders)
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-encoders'])
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    proc.on('close', () => {
      const found = new Set<string>()
      for (const name of Object.values(EXPORT_CODEC_ENCODER)) {
        if (out.includes(name)) found.add(name)
      }
      cachedAvailableEncoders = found
      resolve(found)
    })
    proc.on('error', () => resolve(new Set()))
  })
}

export async function getAvailableCodecs(): Promise<ExportCodec[]> {
  const encoders = await checkEncoderAvailability()
  return (Object.keys(EXPORT_CODEC_ENCODER) as ExportCodec[]).filter((codec) => encoders.has(EXPORT_CODEC_ENCODER[codec]))
}

function resolveClips(sequence: ProjectSequence, mediaById: Record<string, ExportMediaInfo>): { videoClips: ResolvedExportClip[]; audioClips: ResolvedExportClip[] } {
  const { videoClips, audioClips, tracksById } = activeExportClips(sequence)
  const resolve = (clips: typeof videoClips): ResolvedExportClip[] =>
    clips
      .filter((clip) => !!mediaById[clip.mediaId])
      .map((clip) => ({ clip, sourcePath: mediaById[clip.mediaId].originalPath, trackOrder: tracksById[clip.trackId]?.order ?? 0 }))
  return { videoClips: resolve(videoClips), audioClips: resolve(audioClips) }
}

export interface RunExportParams {
  requestId: string
  sequence: ProjectSequence
  mediaById: Record<string, ExportMediaInfo>
  aspectRatio: '16:9' | '9:16' | '1:1'
  options: ExportOptions
  onProgress?: (percent: number) => void
}

export async function runExport(params: RunExportParams): Promise<{ outputPath: string }> {
  const { requestId, sequence, mediaById, aspectRatio, options, onProgress } = params
  const { videoClips, audioClips } = resolveClips(sequence, mediaById)
  const sceneEndTimes: number[] = [] // graphics scenes aren't part of this phase's export
  const durationSeconds = computeExportDurationSeconds(sequence.clips, sceneEndTimes)
  if (durationSeconds <= 0 || (videoClips.length === 0 && audioClips.length === 0)) {
    throw new ExportError('no-content', 'Nothing on the Timeline to export.')
  }

  const wantVideo = options.includeVideo && videoClips.length > 0
  if (wantVideo) {
    const available = await checkEncoderAvailability()
    if (!available.has(EXPORT_CODEC_ENCODER[options.codec])) {
      throw new ExportError('codec-unavailable', `The ${options.codec.toUpperCase()} encoder is not available in this build of ffmpeg.`)
    }
  }

  const dimensions = resolveOutputDimensions(options.resolution, aspectRatio)
  await mkdir(options.outputDir, { recursive: true }).catch(() => {})

  const ext = wantVideo ? 'mp4' : options.audioFormat === 'mp3' ? 'mp3' : 'm4a'
  const safeName = (options.name.trim() || 'export').replace(/[<>:"/\\|?*]/g, '_')
  const finalPath = await uniqueOutputPath(options.outputDir, safeName, ext)
  const tmpPath = join(options.outputDir, `.${requestId}.tmp.${ext}`)

  const { args, isEmpty } = buildExportFilterGraph(videoClips, audioClips, durationSeconds, dimensions, options.frameRate, options, tmpPath)
  if (isEmpty) throw new ExportError('no-content', 'Nothing on the Timeline to export.')

  try {
    await runFfmpeg(requestId, args, { onProgress, totalDurationSeconds: durationSeconds })
    await rename(tmpPath, finalPath)
    return { outputPath: finalPath }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    if (err instanceof Error && err.name === 'CanceledError') throw new ExportError('canceled', 'Export canceled')
    throw new ExportError('ffmpeg-failed', err instanceof Error ? err.message : String(err))
  }
}

/** Second-pass palette-based GIF from an already-exported (or about to be
 * re-exported at GIF-appropriate settings) video -- reuses whatever
 * composite exists rather than a separate compositing pipeline. */
export async function exportGif(requestId: string, sourceVideoPath: string, outputDir: string, name: string, onProgress?: (percent: number) => void): Promise<{ outputPath: string }> {
  const safeName = (name.trim() || 'export').replace(/[<>:"/\\|?*]/g, '_')
  const finalPath = await uniqueOutputPath(outputDir, safeName, 'gif')
  const tmpPath = join(outputDir, `.${requestId}.gif.tmp.gif`)
  try {
    await runFfmpeg(requestId, [
      '-y',
      '-i',
      sourceVideoPath,
      '-vf',
      'fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
      '-progress',
      'pipe:1',
      '-nostats',
      tmpPath
    ], { onProgress })
    await rename(tmpPath, finalPath)
    return { outputPath: finalPath }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    if (err instanceof Error && err.name === 'CanceledError') throw new ExportError('canceled', 'Export canceled')
    throw new ExportError('ffmpeg-failed', err instanceof Error ? err.message : String(err))
  }
}

async function uniqueOutputPath(dir: string, baseName: string, ext: string): Promise<string> {
  let candidate = join(dir, `${baseName}.${ext}`)
  let n = 1
  while (await pathExists(candidate)) {
    candidate = join(dir, `${baseName} (${n}).${ext}`)
    n++
  }
  return candidate
}
