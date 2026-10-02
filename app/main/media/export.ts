import { spawn } from 'child_process'
import { join } from 'path'
import { cpus, freemem, tmpdir } from 'os'
import { rename, unlink, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { app } from 'electron'
import { ffmpegPath } from './ffmpeg'
import { cancelJob, runFfmpeg } from './jobRunner'
import { detectProxyEncodePaths } from './hwAccel'
import { pathExists } from './cache'
import {
  activeExportClips,
  buildExportFilterGraph,
  computeExportDurationSeconds,
  planExportWindows,
  sliceClipsToWindow,
  EXPORT_BITRATE_CRF,
  resolveOutputDimensions,
  EXPORT_CODEC_ENCODER,
  type ExportOptions,
  type ExportCodec,
  type ResolvedExportClip
} from '@shared/export'
import type { ProjectSequence } from '@shared/project'
import { buildAssSubtitles, type ExportOverlay } from '@shared/videoOverlay'
import { buildAssTexts } from '@shared/plainText'

/** The Khmer subtitle font (OFL), shipped as an extraResource -- see
 * electron-builder.yml; read from the checkout's resources/ in dev. */
function subtitleFontsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'fonts') : join(__dirname, '../../resources/fonts')
}

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
  /** Subtitles to burn in and boxes to blur (AI Dubber's "on video"). */
  overlay?: ExportOverlay
  onProgress?: (percent: number) => void
}

export async function runExport(params: RunExportParams): Promise<{ outputPath: string }> {
  const { requestId, sequence, mediaById, aspectRatio, options, overlay, onProgress } = params
  const { videoClips, audioClips } = resolveClips(sequence, mediaById)
  // Add Text's texts are burned in (the other graphics are not exported
  // yet); a text past the last clip makes the video that long.
  const sceneEndTimes = (overlay?.texts ?? []).map((text) => text.end)
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

  let assPath: string | undefined
  if (wantVideo && overlay?.subtitles && overlay.subtitles.lines.length > 0) {
    assPath = join(tmpdir(), `cae-subtitles-${requestId.replace(/[^\w-]/g, '_')}.ass`)
    await writeFile(assPath, buildAssSubtitles(overlay.subtitles.lines, overlay.subtitles.style, dimensions), 'utf-8')
  }
  let textAssPath: string | undefined
  if (wantVideo && overlay?.texts && overlay.texts.length > 0) {
    textAssPath = join(tmpdir(), `cae-texts-${requestId.replace(/[^\w-]/g, '_')}.ass`)
    await writeFile(textAssPath, buildAssTexts(overlay.texts, dimensions), 'utf-8')
  }
  const filterOverlay =
    overlay && (assPath || textAssPath || overlay.blur) ? { blur: overlay.blur, assPath, textAssPath, fontsDir: assPath || textAssPath ? subtitleFontsDir() : undefined } : undefined
  if (buildExportFilterGraph(videoClips, audioClips, durationSeconds, dimensions, options.frameRate, options, tmpPath, filterOverlay).isEmpty) {
    throw new ExportError('no-content', 'Nothing on the Timeline to export.')
  }

  // The GPU's encoder when this computer has one (app/main/media/hwAccel.ts),
  // and on NVIDIA the GPU's decoder too. Whatever fails on this project is
  // dropped for the rest of it: GPU decoding first (a file NVDEC cannot
  // read), then the GPU encoder.
  let gpuCodecArgs = wantVideo ? await gpuVideoCodecArgs(options) : null
  let gpuDecode = !!gpuCodecArgs && gpuCodecArgs[1].endsWith('_nvenc') && (await detectProxyEncodePaths()).includes('nvenc-gpu')
  // Returns the encoder that made the file (pieces are joined as they are,
  // so they must all come from the same one).
  const runOnce = async (jobArgs: (codec: string[] | undefined, gpuDecode: boolean) => string[], seconds: number, report: (percent: number) => void, jobId = requestId): Promise<string> => {
    const passOn = (err: unknown): boolean => err instanceof Error && (err.name === 'CanceledError' || err.name === 'TimeoutError')
    const firstLine = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0] : String(err))
    if (gpuCodecArgs && gpuDecode) {
      try {
        await runFfmpeg(jobId, jobArgs(gpuCodecArgs, true), { onProgress: report, totalDurationSeconds: seconds })
        return gpuCodecArgs[1]
      } catch (err) {
        if (passOn(err)) throw err
        console.warn(`[export] GPU decoding failed, decoding on the CPU: ${firstLine(err)}`)
        gpuDecode = false
      }
    }
    if (gpuCodecArgs) {
      try {
        await runFfmpeg(jobId, jobArgs(gpuCodecArgs, false), { onProgress: report, totalDurationSeconds: seconds })
        return gpuCodecArgs[1]
      } catch (err) {
        if (passOn(err)) throw err
        console.warn(`[export] GPU encoder failed, using the CPU encoder: ${firstLine(err)}`)
        gpuCodecArgs = null
      }
    }
    await runFfmpeg(jobId, jobArgs(undefined, false), { onProgress: report, totalDurationSeconds: seconds })
    return 'cpu'
  }
  const currentEncoder = (): string => gpuCodecArgs?.[1] ?? 'cpu'

  // Windows of the Timeline, one ffmpeg run each (shared/export.ts's
  // planExportWindows): few clips per run, so a long, many-clip project
  // neither overflows the Windows command line nor decodes its film from
  // the start for every clip. One window when everything fits.
  const windows = planExportWindows(
    [...videoClips.map((rc) => ({ startTime: rc.clip.startTime, duration: rc.clip.duration, isAudio: false })), ...(options.includeAudio ? audioClips : []).map((rc) => ({ startTime: rc.clip.startTime, duration: rc.clip.duration, fadeIn: rc.clip.fadeIn, fadeOut: rc.clip.fadeOut, isAudio: true }))],
    durationSeconds,
    options.frameRate
  )
  const pieceDir = windows.length > 1 ? await mkdtemp(join(tmpdir(), 'cae-export-')) : null
  try {
    if (!pieceDir) {
      await runOnce(
        (codec, onGpu) => buildExportFilterGraph(videoClips, audioClips, durationSeconds, dimensions, options.frameRate, options, tmpPath, filterOverlay, { seekInputs: true, videoCodecArgs: codec, gpuDecode: onGpu }).args,
        durationSeconds,
        (percent) => onProgress?.(percent)
      )
    } else {
      // MOV pieces: exact per-frame times (MKV rounds them to whole
      // milliseconds, and 1/30 s frames then collided at every join).
      const pieces = windows.map((_, i) => join(pieceDir, `piece_${String(i).padStart(4, '0')}.mov`))
      const pieceDone = windows.map(() => 0)
      const report = (): void => onProgress?.(Math.min(96, (pieceDone.reduce((a, b) => a + b, 0) / durationSeconds) * 96))
      // Several pieces at once: the GPU encodes a few streams side by side;
      // a CPU with cores to spare takes two; a small one, one at a time.
      // ~1.6 GB a piece at most (decoder threads capped below), so never
      // more pieces than free memory holds -- a small machine runs one.
      const byMemory = Math.max(1, Math.floor(freemem() / (2 * 1024 ** 3)))
      const parallel = Math.min(byMemory, gpuCodecArgs ? Math.min(4, Math.max(2, Math.floor(cpus().length / 4))) : cpus().length > 8 ? 2 : 1)
      const madeBy: string[] = windows.map(() => '')
      let queue = windows.map((_, i) => i)
      let failure: unknown = null
      const worker = async (): Promise<void> => {
        while (queue.length > 0 && !failure) {
          const i = queue.shift()!
          const window = windows[i]
          const length = window.end - window.start
          const pieceVideo = sliceClipsToWindow(videoClips, window)
          const pieceAudio = sliceClipsToWindow(audioClips, window)
          madeBy[i] = await runOnce(
            (codec, onGpu) =>
              buildExportFilterGraph(pieceVideo, pieceAudio, length, dimensions, options.frameRate, options, pieces[i], filterOverlay, {
                seekInputs: true,
                videoCodecArgs: codec,
                gpuDecode: onGpu,
                forceVideo: wantVideo,
                timeOffset: window.start,
                silentBed: true,
                pcmAudio: true,
                // Always capped: an HEVC decoder's default (a thread per core)
                // held ~3 GB for one piece -- most of an 8 GB machine.
                decoderThreads: parallel > 1 ? 2 : 4
              }).args,
            length,
            (percent) => {
              pieceDone[i] = (percent / 100) * length
              report()
            },
            `${requestId}:${i}`
          )
          pieceDone[i] = length
          report()
        }
      }
      // One piece failing stops the rest: no new pieces, the running ones
      // stopped -- and none left writing into the folder removed below.
      const runAll = async (): Promise<void> => {
        await Promise.all(
          Array.from({ length: Math.min(parallel, queue.length) }, () =>
            worker().catch((err) => {
              if (!failure) failure = err
              cancelJob(requestId)
            })
          )
        )
        if (failure) throw failure
      }
      await runAll()
      // A GPU encoder that gave up partway made the earlier pieces in another
      // encoding than the later ones; joined as they are, the video would
      // break at the first change. Those are made again, the same way.
      for (let pass = 0; pass < 2 && madeBy.some((by) => by !== currentEncoder()); pass++) {
        queue = madeBy.flatMap((by, i) => (by !== currentEncoder() ? [i] : []))
        for (const i of queue) pieceDone[i] = 0
        await runAll()
      }
      // Joined end to end without re-encoding the picture; the sound is
      // encoded once, here, so there is no gap at any join.
      const listPath = join(pieceDir, 'pieces.txt')
      await writeFile(listPath, pieces.map((piece) => `file '${piece.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8')
      const audioArgs = options.includeAudio ? ['-c:a', options.audioFormat === 'mp3' && !wantVideo ? 'libmp3lame' : 'aac', '-b:a', '192k'] : ['-an']
      await runFfmpeg(requestId, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0', ...(wantVideo ? ['-c:v', 'copy'] : ['-vn']), ...audioArgs, ...(wantVideo ? ['-movflags', '+faststart'] : []), '-progress', 'pipe:1', '-nostats', tmpPath], {
        onProgress: (percent) => onProgress?.(96 + percent * 0.04),
        totalDurationSeconds: durationSeconds
      })
    }
    await rename(tmpPath, finalPath)
    return { outputPath: finalPath }
  } catch (err) {
    await removeLeftover(tmpPath)
    if (err instanceof Error && err.name === 'CanceledError') throw new ExportError('canceled', 'Export canceled')
    throw failedExport(err)
  } finally {
    if (assPath) await unlink(assPath).catch(() => {})
    if (textAssPath) await unlink(textAssPath).catch(() => {})
    if (pieceDir) await rm(pieceDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The video encoder arguments for this computer's GPU, at the quality the
 * chosen preset asks for -- null when there is no usable GPU encoder for the
 * codec (the CPU encoder then runs as before). */
async function gpuVideoCodecArgs(options: ExportOptions): Promise<string[] | null> {
  const paths = await detectProxyEncodePaths()
  const quality = options.bitratePreset === 'custom' ? null : String(EXPORT_BITRATE_CRF[options.bitratePreset])
  const rate = options.bitratePreset === 'custom' && options.customBitrateKbps ? ['-b:v', `${options.customBitrateKbps}k`] : null
  const family = options.codec === 'h264' ? 'h264' : options.codec === 'hevc' ? 'hevc' : null
  if (!family) return null
  // The encoder's quickest setting, as CapCut does: p1 encoded a minute of
  // 2K 60 fps in 4.6 s where p4 took 8.1 s, for 16% more bytes and a
  // picture all but identical (SSIM 0.994). "Higher" keeps the slower,
  // tighter p5.
  const fast = options.bitratePreset !== 'higher'
  if (paths.includes('nvenc')) return ['-c:v', `${family}_nvenc`, '-preset', fast ? 'p1' : 'p5', ...(rate ?? ['-rc', 'vbr', '-cq', quality ?? '23', '-b:v', '0'])]
  if (paths.includes('qsv')) return ['-c:v', `${family}_qsv`, '-preset', fast ? 'veryfast' : 'medium', ...(rate ?? ['-global_quality', quality ?? '23'])]
  if (paths.includes('amf')) return ['-c:v', `${family}_amf`, '-quality', fast ? 'speed' : 'balanced', ...(rate ?? ['-rc', 'cqp', '-qp_i', quality ?? '23', '-qp_p', quality ?? '23'])]
  return null
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
    await removeLeftover(tmpPath)
    if (err instanceof Error && err.name === 'CanceledError') throw new ExportError('canceled', 'Export canceled')
    throw failedExport(err)
  }
}

/** The error to show for a failed run: a full disk said in plain words
 * (the pieces of a long export wait in the temp folder until joined). */
function failedExport(err: unknown): ExportError {
  const message = err instanceof Error ? err.message : String(err)
  if (/No space left on device|ENOSPC|There is not enough space/i.test(message)) {
    return new ExportError('io', `Not enough free disk space. A long export needs room for about twice the video's size (drive ${tmpdir().slice(0, 2)} and the export folder's drive). Free some space and export again.`)
  }
  return new ExportError('ffmpeg-failed', message)
}

/** Deletes a failed export's partial file. Windows keeps a just-killed
 * ffmpeg's file locked for a moment, and a single try then left a broken
 * multi-GB file (no sound, no end) in the user's folder. */
async function removeLeftover(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await unlink(path)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
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
