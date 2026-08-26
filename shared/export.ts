// Real video export -- shared types, presets, and the PURE ffmpeg
// filter_complex argument builder (no ffmpeg, no fs, no Electron -- fully
// unit-testable). app/main/media/export.ts is the only thing that actually
// runs these args through ffmpeg. Mirrors shared/localAi.ts's own
// "pure/testable core + thin main-process runner" split.
import type { ProjectSequence, TimelineClip } from './project'
import type { TimelineTrack } from './timelineTracks'

export const EXPORT_RESOLUTION_VALUES = ['480p', '720p', '1080p', '2k', '4k'] as const
export type ExportResolution = (typeof EXPORT_RESOLUTION_VALUES)[number]

/** Height in pixels each preset targets -- width is derived from the
 * project's own aspect ratio (see resolveOutputDimensions), not hardcoded
 * 16:9, so a 9:16 or 1:1 project exports at the right shape. */
export const EXPORT_RESOLUTION_HEIGHTS: Record<ExportResolution, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '2k': 1440,
  '4k': 2160
}

export const EXPORT_BITRATE_VALUES = ['lower', 'recommended', 'higher', 'custom'] as const
export type ExportBitratePreset = (typeof EXPORT_BITRATE_VALUES)[number]

/** CRF (Constant Rate Factor), not a fixed bitrate target -- same
 * quality-consistent approach app/main/media/proxy.ts already uses (crf 28).
 * Lower CRF = higher quality/larger file. Ignored when preset is 'custom'
 * (ExportOptions.customBitrateKbps is used instead). */
export const EXPORT_BITRATE_CRF: Record<Exclude<ExportBitratePreset, 'custom'>, number> = {
  lower: 28,
  recommended: 23,
  higher: 18
}

export const EXPORT_CODEC_VALUES = ['h264', 'hevc', 'av1'] as const
export type ExportCodec = (typeof EXPORT_CODEC_VALUES)[number]

/** ffmpeg encoder name per codec. HEVC/AV1 availability in the bundled
 * ffmpeg-static binary is verified at runtime (see checkEncoderAvailability
 * in app/main/media/export.ts) -- the renderer disables an unavailable
 * codec's option rather than letting an export silently fail. */
export const EXPORT_CODEC_ENCODER: Record<ExportCodec, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libaom-av1'
}

export const EXPORT_FRAME_RATE_VALUES = [24, 25, 30, 50, 60] as const
export type ExportFrameRate = (typeof EXPORT_FRAME_RATE_VALUES)[number]

export const EXPORT_AUDIO_FORMAT_VALUES = ['aac', 'mp3'] as const
export type ExportAudioFormat = (typeof EXPORT_AUDIO_FORMAT_VALUES)[number]

/** Project aspect ratio -> [W, H] ratio parts. Duplicated (deliberately, not
 * imported) from renderer/src/media/PreviewPlayer.tsx's identical
 * ASPECT_RATIO_PARTS -- that file is renderer-only and this needs to run in
 * the main process too; both are 3-line consts unlikely to drift. */
export const EXPORT_ASPECT_RATIO_PARTS: Record<'16:9' | '9:16' | '1:1', [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1]
}

export interface ExportOptions {
  name: string
  outputDir: string
  /** False = audio-only export (no video track at all, output as an audio
   * file) -- matches the reference dialog's own checkbox on the "Video"
   * section header. */
  includeVideo: boolean
  resolution: ExportResolution
  bitratePreset: ExportBitratePreset
  /** Only read when bitratePreset === 'custom'. */
  customBitrateKbps?: number
  codec: ExportCodec
  frameRate: ExportFrameRate
  includeAudio: boolean
  audioFormat: ExportAudioFormat
  exportGif: boolean
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  name: '',
  outputDir: '',
  includeVideo: true,
  resolution: '480p',
  bitratePreset: 'lower',
  codec: 'h264',
  frameRate: 30,
  includeAudio: true,
  audioFormat: 'aac',
  exportGif: false
}

export interface ExportProgress {
  requestId: string
  percent: number
  status: 'exporting' | 'success' | 'error' | 'canceled'
  outputPath?: string
  message?: string
}

export type ExportErrorKind = 'no-content' | 'codec-unavailable' | 'ffmpeg-failed' | 'canceled' | 'io' | 'unknown'

export interface ExportError {
  kind: ExportErrorKind
  message: string
}

export const EXPORT_IPC = {
  pickOutputDir: 'export:pickOutputDir',
  getCapabilities: 'export:getCapabilities',
  startExport: 'export:startExport',
  cancelExport: 'export:cancelExport',
  progress: 'export:progress'
} as const

export interface ExportCapabilities {
  ffmpegAvailable: boolean
  availableCodecs: ExportCodec[]
  /** The OS's default Videos folder -- pre-fills "Export to" so the Export
   * button isn't stuck disabled behind an empty, easy-to-miss folder field
   * (matches the reference dialog, which always shows a real default path
   * rather than a placeholder). */
  defaultOutputDir: string
}

/** Resolves an ExportResolution + the project's aspect ratio to real,
 * even (yuv420p-safe) output pixel dimensions. */
export function resolveOutputDimensions(resolution: ExportResolution, aspectRatio: keyof typeof EXPORT_ASPECT_RATIO_PARTS): { width: number; height: number } {
  const [arW, arH] = EXPORT_ASPECT_RATIO_PARTS[aspectRatio]
  const height = EXPORT_RESOLUTION_HEIGHTS[resolution]
  const rawWidth = (height * arW) / arH
  // Even dimensions are required by yuv420p (matches stillImage.ts's own
  // trunc(iw/2)*2 precedent).
  const width = Math.round(rawWidth / 2) * 2
  return { width, height: Math.round(height / 2) * 2 }
}

/** The real (un-padded) end of the last visible content -- NOT
 * ProjectSequence.duration, which is always +5s padded past the last clip
 * (see computeSequenceDuration in shared/project.ts) and would export 5
 * extra seconds of dead air/black if used directly. Scenes aren't part of
 * this phase's export (graphics burn-in is a later phase) but are included
 * here so this function stays correct once that phase reuses it. */
export function computeExportDurationSeconds(clips: TimelineClip[], sceneEndTimes: number[] = []): number {
  let end = 0
  for (const clip of clips) end = Math.max(end, clip.startTime + clip.duration)
  for (const t of sceneEndTimes) end = Math.max(end, t)
  return end
}

/** One clip resolved with everything the filter-graph builder needs that
 * TimelineClip alone doesn't carry (the real source file path, and whether
 * this clip's audio should actually be mixed in). Built by the caller
 * (app/main/media/export.ts) by joining TimelineClip against MediaSource. */
export interface ResolvedExportClip {
  clip: TimelineClip
  sourcePath: string
  trackOrder: number
}

export interface ExportFilterGraphResult {
  /** Full ffmpeg argument list (excluding the leading binary path itself). */
  args: string[]
  /** True if there's nothing to export (no active clips) -- caller should
   * reject with kind: 'no-content' rather than invoking ffmpeg at all. */
  isEmpty: boolean
}

/** Builds a complete ffmpeg filter_complex export for the "simple case"
 * (Phase 2 of the export plan): every active (non-hidden-track) video/image
 * clip is placed on a black base canvas at its own startTime via a timed
 * `overlay`, in ascending track-order (so a higher-order track's clip paints
 * over a lower one during any overlap -- Phase 3 extends real multi-track
 * simultaneity; this already handles gaps and non-overlapping arrangement
 * correctly since the base canvas shows through wherever nothing is
 * scheduled). Every active, unmuted audio-bearing clip (video's own audio
 * when not `muted`, or a dedicated audio clip) is trimmed, volume/fade-
 * adjusted, and mixed via `amix`. Per-clip opacity/transform/crop/
 * playbackRate/fadeIn/fadeOut are all applied, matching
 * renderer/src/media/PreviewPlayer.tsx's own compositing math. */
export function buildExportFilterGraph(
  videoClips: ResolvedExportClip[],
  audioClips: ResolvedExportClip[],
  durationSeconds: number,
  dimensions: { width: number; height: number },
  frameRate: number,
  options: Pick<ExportOptions, 'codec' | 'bitratePreset' | 'customBitrateKbps' | 'includeVideo' | 'includeAudio' | 'audioFormat'>,
  outputPath: string
): ExportFilterGraphResult {
  const wantVideo = options.includeVideo && videoClips.length > 0
  if (!wantVideo && (audioClips.length === 0 || !options.includeAudio)) {
    return { args: [], isEmpty: true }
  }

  const sortedVideo = wantVideo ? [...videoClips].sort((a, b) => a.trackOrder - b.trackOrder || a.clip.startTime - b.clip.startTime) : []
  // Dedupe input files -- several clips can share one source (e.g. two trims
  // of the same import), each still gets its own `-i` here for simplicity
  // (ffmpeg handles repeated identical -i inputs fine; a future pass could
  // dedupe further, not worth the complexity at this scale).
  const inputs: string[] = []
  const inputArgs: string[] = []
  const videoInputIndex = new Map<ResolvedExportClip, number>()
  const audioInputIndex = new Map<ResolvedExportClip, number>()

  for (const rc of sortedVideo) {
    inputArgs.push('-i', rc.sourcePath)
    videoInputIndex.set(rc, inputs.length)
    inputs.push(rc.sourcePath)
  }
  if (options.includeAudio) {
    for (const rc of audioClips) {
      inputArgs.push('-i', rc.sourcePath)
      audioInputIndex.set(rc, inputs.length)
      inputs.push(rc.sourcePath)
    }
  }

  const filterParts: string[] = []
  if (wantVideo) filterParts.push(`color=c=black:s=${dimensions.width}x${dimensions.height}:d=${durationSeconds}:r=${frameRate}[base0]`)

  let lastLabel = 'base0'
  sortedVideo.forEach((rc, i) => {
    const idx = videoInputIndex.get(rc)!
    const { clip } = rc
    const sourceOut = clip.sourceOut ?? clip.sourceIn + clip.duration
    const rate = clip.playbackRate ?? 1
    const opacity = clip.opacity ?? 1
    const t = clip.transform

    const steps: string[] = [`trim=start=${clip.sourceIn}:end=${sourceOut}`, 'setpts=PTS-STARTPTS']
    if (rate !== 1) steps.push(`setpts=PTS/${rate}`)
    if (t && (t.cropTop || t.cropRight || t.cropBottom || t.cropLeft)) {
      steps.push(`crop=iw*(1-${t.cropLeft}-${t.cropRight}):ih*(1-${t.cropTop}-${t.cropBottom}):iw*${t.cropLeft}:ih*${t.cropTop}`)
    }
    steps.push(`scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`)
    if (t && (t.scaleX !== 1 || t.scaleY !== 1)) steps.push(`scale=iw*${t.scaleX ?? 1}:ih*${t.scaleY ?? 1}`)
    if (t && t.rotation) steps.push(`rotate=${(t.rotation * Math.PI) / 180}:c=none`)
    if (opacity < 1) steps.push(`format=yuva420p,colorchannelmixer=aa=${opacity}`)
    steps.push(`setpts=PTS-STARTPTS+${clip.startTime}/TB`)

    const clipLabel = `v${i}`
    filterParts.push(`[${idx}:v]${steps.join(',')}[${clipLabel}]`)

    const x = t ? `(W-w)/2+${t.x}` : '(W-w)/2'
    const y = t ? `(H-h)/2+${t.y}` : '(H-h)/2'
    const nextLabel = `ov${i}`
    const end = clip.startTime + clip.duration
    filterParts.push(`[${lastLabel}][${clipLabel}]overlay=x=${x}:y=${y}:enable='between(t,${clip.startTime},${end})'[${nextLabel}]`)
    lastLabel = nextLabel
  })
  if (wantVideo) filterParts.push(`[${lastLabel}]format=yuv420p[vout]`)

  const audioLabels: string[] = []
  if (options.includeAudio) {
    audioClips.forEach((rc, i) => {
      const idx = audioInputIndex.get(rc)!
      const { clip } = rc
      const sourceOut = clip.sourceOut ?? clip.sourceIn + clip.duration
      const volume = clip.volume ?? 1
      const steps: string[] = [`atrim=start=${clip.sourceIn}:end=${sourceOut}`, 'asetpts=PTS-STARTPTS']
      if (clip.playbackRate && clip.playbackRate !== 1) steps.push(`atempo=${Math.max(0.5, Math.min(2, clip.playbackRate))}`)
      if (volume !== 1) steps.push(`volume=${volume}`)
      if (clip.fadeIn) steps.push(`afade=t=in:st=0:d=${clip.fadeIn}`)
      if (clip.fadeOut) steps.push(`afade=t=out:st=${Math.max(0, clip.duration - clip.fadeOut)}:d=${clip.fadeOut}`)
      steps.push(`adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)}`)
      const label = `a${i}`
      filterParts.push(`[${idx}:a]${steps.join(',')}[${label}]`)
      audioLabels.push(label)
    })
  }

  let audioOutLabel: string | null = null
  if (audioLabels.length > 0) {
    if (audioLabels.length === 1) {
      audioOutLabel = audioLabels[0]
    } else {
      filterParts.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0[aout]`)
      audioOutLabel = 'aout'
    }
  }

  const args: string[] = ['-y', ...inputArgs, '-filter_complex', filterParts.join(';')]
  if (wantVideo) args.push('-map', '[vout]')
  if (audioOutLabel) args.push('-map', `[${audioOutLabel}]`)

  if (wantVideo) {
    args.push('-c:v', EXPORT_CODEC_ENCODER[options.codec])
    if (options.bitratePreset === 'custom' && options.customBitrateKbps) {
      args.push('-b:v', `${options.customBitrateKbps}k`)
    } else if (options.bitratePreset !== 'custom') {
      args.push('-crf', String(EXPORT_BITRATE_CRF[options.bitratePreset]))
    }
    args.push('-pix_fmt', 'yuv420p', '-r', String(frameRate))
  } else {
    args.push('-vn')
  }

  if (audioOutLabel) {
    args.push('-c:a', options.audioFormat === 'mp3' ? 'libmp3lame' : 'aac', '-b:a', '192k')
  } else {
    args.push('-an')
  }

  args.push('-t', String(durationSeconds))
  if (wantVideo) args.push('-movflags', '+faststart')
  args.push('-progress', 'pipe:1', '-nostats', outputPath)

  return { args, isEmpty: false }
}

/** Rough kbps ballpark per resolution+CRF combo, for the dialog's "estimated
 * size" footer only (never used to actually drive encoding -- CRF is what
 * really controls output size/quality, this is just a labeled estimate). */
const APPROX_KBPS_AT_CRF23: Record<ExportResolution, number> = {
  '480p': 800,
  '720p': 1800,
  '1080p': 3500,
  '2k': 6000,
  '4k': 14000
}
const CRF_SIZE_MULTIPLIER: Record<Exclude<ExportBitratePreset, 'custom'>, number> = { lower: 0.6, recommended: 1, higher: 1.7 }

/** Estimated output size in MB, for display only. */
export function estimateOutputSizeMB(durationSeconds: number, options: Pick<ExportOptions, 'resolution' | 'bitratePreset' | 'customBitrateKbps'>): number {
  const kbps =
    options.bitratePreset === 'custom' && options.customBitrateKbps
      ? options.customBitrateKbps
      : APPROX_KBPS_AT_CRF23[options.resolution] * CRF_SIZE_MULTIPLIER[options.bitratePreset === 'custom' ? 'recommended' : options.bitratePreset]
  const audioKbps = 192
  return ((kbps + audioKbps) * durationSeconds) / 8 / 1024
}

/** Filters a sequence's clips/tracks down to what's actually eligible for
 * export -- excludes hidden tracks (matches Preview's own exclusion) and
 * disabled clips, keeps locked ones (locked is edit-protection only). */
export function activeExportClips(sequence: ProjectSequence): { videoClips: TimelineClip[]; audioClips: TimelineClip[]; tracksById: Record<string, TimelineTrack> } {
  const tracksById = Object.fromEntries(sequence.tracks.map((t) => [t.id, t] as const))
  const eligible = sequence.clips.filter((c) => c.enabled !== false && !tracksById[c.trackId]?.hidden)
  const videoClips = eligible.filter((c) => c.type === 'video' || c.type === 'image')
  const audioClips = eligible.filter((c) => c.type === 'audio' || (c.type === 'video' && !c.muted))
  return { videoClips, audioClips, tracksById }
}
