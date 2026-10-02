// Real video export -- shared types, presets, and the PURE ffmpeg
// filter_complex argument builder (no ffmpeg, no fs, no Electron -- fully
// unit-testable). app/main/media/export.ts is the only thing that actually
// runs these args through ffmpeg. Mirrors shared/localAi.ts's own
// "pure/testable core + thin main-process runner" split.
import { buildOverlayFilterSteps, type BlurSettings } from './videoOverlay'
import type { ProjectSequence, TimelineClip } from './project'
import { clipRate, sourceEnd } from './clipTiming'
import { clipMotionExprs } from './clipMotion'
import type { TimelineTrack } from './timelineTracks'
import { isTrackAudioMuted } from './timelineTracks'

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
  /** Also write the AI Dubber's subtitles as `<name>.srt`, carrying each
   * line's speaker, male/female, voice, pitch, speed and volume so that
   * importing it again restores them (shared/dubbingSrt.ts). Handled by the
   * renderer; the video export ignores it. */
  exportSrt: boolean
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
  exportGif: false,
  exportSrt: false
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
  openOutput: 'export:openOutput',
  /** Writes a small text file (the dubbing SRT) into the export folder under
   * a name that never overwrites an existing file. */
  writeTextFile: 'export:writeTextFile',
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
  /** Seconds of the clip already played before this run starts (a window
   * of a longer export): its motion carries on from there. */
  motionOffset?: number
}

export interface ExportFilterGraphResult {
  /** Full ffmpeg argument list (excluding the leading binary path itself). */
  args: string[]
  /** True if there's nothing to export (no active clips) -- caller should
   * reject with kind: 'no-content' rather than invoking ffmpeg at all. */
  isEmpty: boolean
}

/** How one ffmpeg run of an export is built (all optional: none = one run
 * over the whole Timeline, as before). */
export interface ExportBuildOptions {
  /** Open each input at its own stretch with -ss/-t instead of trim. */
  seekInputs?: boolean
  /** The video encoder and its quality settings (a GPU encoder, say) in
   * place of EXPORT_CODEC_ENCODER + CRF. */
  videoCodecArgs?: string[]
  /** Project time where this run starts (a window of a longer export):
   * the burned-in subtitles are timed in project time. */
  timeOffset?: number
  /** Always an audio track of the full length (silence under it). */
  silentBed?: boolean
  /** PCM audio, for a piece that is joined and encoded afterwards. */
  pcmAudio?: boolean
  /** Decoder threads per video input: several pieces run at once, and an
   * HEVC decoder's default (one thread per core) held ~90 MB a thread --
   * 3.2 GB per piece with ~35 inputs; 2 threads halved that at no cost. */
  decoderThreads?: number
  /** Decode and fit the videos on an NVIDIA GPU (NVDEC + scale_cuda): a
   * piece's 13 film inputs went 1.6x quicker, for ~0.5 GB of video memory,
   * and the CPU -- the slow part of a small machine -- is left nearly idle.
   * A cropped clip still goes through the CPU (the crop comes first). */
  gpuDecode?: boolean
  /** A picture even with no video clip in this run (black): every piece of
   * a longer export must carry the same streams to be joined. */
  forceVideo?: boolean
}

function seconds(value: number): string {
  return String(Math.round(value * 1e6) / 1e6)
}

/** A stretch of the Timeline exported by one ffmpeg run. */
export interface ExportWindow {
  start: number
  end: number
}

/** Most inputs one ffmpeg run gets: every clip is an input, and Windows
 * cuts a command line off at 32,767 characters -- a 1,900-clip Timeline
 * (Video Sync pieces plus a dub line each) could not be exported at all. */
export const EXPORT_MAX_INPUTS_PER_RUN = 40
/** Longest window, so progress and cancelling stay responsive. */
export const EXPORT_MAX_WINDOW_SECONDS = 300

/** Splits the Timeline into windows each run can take: at most
 * `maxInputs` clips (video and audio) touching a window, at most
 * `maxSeconds` long, boundaries on the frame grid -- and never inside an
 * audio clip's fade (a fade cut in two would restart). One window when the
 * whole Timeline fits. */
export function planExportWindows(
  clips: { startTime: number; duration: number; fadeIn?: number; fadeOut?: number; isAudio: boolean }[],
  durationSeconds: number,
  frameRate: number,
  maxInputs = EXPORT_MAX_INPUTS_PER_RUN,
  maxSeconds = EXPORT_MAX_WINDOW_SECONDS
): ExportWindow[] {
  if (durationSeconds <= 0) return []
  const touching = (a: number, b: number): number => clips.filter((c) => c.startTime < b && c.startTime + c.duration > a).length
  if (touching(0, durationSeconds) <= maxInputs) return [{ start: 0, end: durationSeconds }]
  const frame = 1 / frameRate
  const snap = (t: number): number => Math.round(t / frame) * frame
  // Where a boundary must not fall: inside an audio fade.
  const fades: [number, number][] = []
  for (const c of clips) {
    if (!c.isAudio) continue
    if (c.fadeIn) fades.push([c.startTime, c.startTime + c.fadeIn])
    if (c.fadeOut) fades.push([c.startTime + c.duration - c.fadeOut, c.startTime + c.duration])
  }
  const clearOfFades = (t: number): number => {
    for (let moved = true; moved; ) {
      moved = false
      for (const [a, b] of fades) {
        if (t > a + 1e-6 && t < b - 1e-6) {
          t = snap(b + frame / 2)
          moved = true
        }
      }
    }
    return t
  }
  const windows: ExportWindow[] = []
  let start = 0
  while (start < durationSeconds - 1e-6) {
    let length = Math.min(maxSeconds, durationSeconds - start)
    while (length > frame && touching(start, start + length) > maxInputs) length /= 2
    let end = start + length >= durationSeconds - 1e-6 ? durationSeconds : clearOfFades(snap(start + length))
    if (end <= start + 1e-6) end = Math.min(durationSeconds, snap(start + frame * 2))
    if (end >= durationSeconds - frame / 2) end = durationSeconds
    windows.push({ start, end })
    start = end
  }
  return windows
}

/** The clips of a window, cut to it and timed from its start: a clip
 * running into the window from before starts at 0 further into its file
 * (by the playback rate); one running past it is cut at its end. Fades
 * stay with the part that holds them (planExportWindows never cuts one). */
export function sliceClipsToWindow(clips: ResolvedExportClip[], window: ExportWindow): ResolvedExportClip[] {
  const out: ResolvedExportClip[] = []
  for (const rc of clips) {
    const { clip } = rc
    const from = Math.max(clip.startTime, window.start)
    const to = Math.min(clip.startTime + clip.duration, window.end)
    if (to - from <= 1e-6) continue
    const rate = clipRate(clip)
    const sourceIn = clip.sourceIn + (from - clip.startTime) * rate
    const duration = to - from
    const cutStart = from > clip.startTime + 1e-6
    const cutEnd = to < clip.startTime + clip.duration - 1e-6
    out.push({
      ...rc,
      motionOffset: (rc.motionOffset ?? 0) + (from - clip.startTime),
      clip: {
        ...clip,
        startTime: from - window.start,
        duration,
        sourceIn,
        sourceOut: sourceIn + duration * rate,
        fadeIn: cutStart ? undefined : clip.fadeIn,
        fadeOut: cutEnd ? undefined : clip.fadeOut
      }
    })
  }
  return out
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
  outputPath: string,
  /** Blur boxes and burned-in subtitles over the finished picture. */
  overlay?: { blur?: BlurSettings; assPath?: string; textAssPath?: string; fontsDir?: string },
  build: ExportBuildOptions = {}
): ExportFilterGraphResult {
  const wantVideo = options.includeVideo && (videoClips.length > 0 || !!build.forceVideo)
  if (!wantVideo && (!options.includeAudio || (audioClips.length === 0 && !build.silentBed))) {
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

  // seekInputs: each input opened at its own stretch (`-ss`/`-t` before
  // `-i`: the decoder starts at the nearest keyframe and drops the frames
  // before the point) instead of `trim` -- which decodes the file from its
  // very start: a clip at minute 80 of a film decoded 80 minutes to keep
  // two seconds.
  const onGpu = (rc: ResolvedExportClip): boolean => {
    const t = rc.clip.transform
    return !!build.gpuDecode && rc.clip.type === 'video' && !(t && (t.cropTop || t.cropRight || t.cropBottom || t.cropLeft))
  }
  const inputFor = (rc: ResolvedExportClip): string[] => {
    // A still image is one frame at time 0: a window starting partway
    // through its clip would seek past it and show nothing. A moving one
    // needs a frame for every moment it moves.
    if (rc.clip.type === 'image') {
      return rc.clip.motion ? ['-loop', '1', '-framerate', String(frameRate), '-t', seconds(Math.max(0.001, rc.clip.duration * clipRate(rc.clip))), '-i', rc.sourcePath] : ['-i', rc.sourcePath]
    }
    if (!build.seekInputs) return ['-i', rc.sourcePath]
    const length = Math.max(0.001, sourceEnd(rc.clip) - rc.clip.sourceIn)
    return ['-ss', seconds(rc.clip.sourceIn), '-t', seconds(length), '-i', rc.sourcePath]
  }
  for (const rc of sortedVideo) {
    if (onGpu(rc)) inputArgs.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda')
    else if (build.decoderThreads) inputArgs.push('-threads', String(build.decoderThreads))
    inputArgs.push(...inputFor(rc))
    videoInputIndex.set(rc, inputs.length)
    inputs.push(rc.sourcePath)
  }
  if (options.includeAudio) {
    for (const rc of audioClips) {
      inputArgs.push(...inputFor(rc))
      audioInputIndex.set(rc, inputs.length)
      inputs.push(rc.sourcePath)
    }
  }

  const filterParts: string[] = []
  const canvas = `color=c=black:s=${dimensions.width}x${dimensions.height}:r=${frameRate}`
  // A clip's own picture: its stretch of the file at its speed, cropped,
  // fitted to the frame, scaled, turned and faded as on the Timeline.
  const clipPicture = (rc: ResolvedExportClip): string[] => {
    const { clip } = rc
    const rate = clipRate(clip)
    const opacity = clip.opacity ?? 1
    const t = clip.transform
    const steps: string[] = build.seekInputs ? ['setpts=PTS-STARTPTS'] : [`trim=start=${clip.sourceIn}:end=${sourceEnd(clip)}`, 'setpts=PTS-STARTPTS']
    if (rate !== 1) steps.push(`setpts=PTS/${rate}`)
    if (t && (t.cropTop || t.cropRight || t.cropBottom || t.cropLeft)) {
      steps.push(`crop=iw*(1-${t.cropLeft}-${t.cropRight}):ih*(1-${t.cropTop}-${t.cropBottom}):iw*${t.cropLeft}:ih*${t.cropTop}`)
    }
    if (onGpu(rc)) steps.push(`scale_cuda=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:format=yuv420p`, 'hwdownload', 'format=yuv420p')
    else steps.push(`scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`)
    if (t && (t.scaleX !== 1 || t.scaleY !== 1)) steps.push(`scale=iw*${t.scaleX ?? 1}:ih*${t.scaleY ?? 1}`)
    // Motion (shared/clipMotion.ts), `t` here being seconds into the clip:
    // turned first at a fixed size (a turn after a size change smeared),
    // then sized frame by frame.
    const motion = clip.motion ? clipMotionExprs(clip.motion, `t+${seconds(rc.motionOffset ?? 0)}`) : null
    const turn = t?.rotation ? (t.rotation * Math.PI) / 180 : 0
    if (motion?.rotate) steps.push('format=rgba', `rotate=a='${turn ? `${turn}+` : ''}${motion.rotate}':c=none:ow='hypot(iw,ih)':oh=ow`)
    else if (turn) steps.push(`rotate=${turn}:c=none`)
    if (motion?.scale) steps.push(`scale=w='max(2,trunc(iw*${motion.scale}/2)*2)':h='max(2,trunc(ih*${motion.scale}/2)*2)':eval=frame`)
    if (opacity < 1) steps.push(`format=yuva420p,colorchannelmixer=aa=${opacity}`)
    return steps
  }
  // Shown whole and centred, as fitted: no moving, zoom, turn or fade.
  const isPlainPicture = (clip: TimelineClip): boolean => {
    const t = clip.transform
    return !clip.motion && (clip.opacity ?? 1) >= 1 && (!t || (!t.x && !t.y && (t.scaleX ?? 1) === 1 && (t.scaleY ?? 1) === 1 && !t.rotation))
  }
  // Where the picture sits; `clipTime` is the overlay's time expressed as
  // seconds into the clip, for its motion.
  const place = (rc: ResolvedExportClip, clipTime: string): { x: string; y: string } => {
    const t = rc.clip.transform
    const motion = rc.clip.motion ? clipMotionExprs(rc.clip.motion, `${clipTime}+${seconds(rc.motionOffset ?? 0)}`) : null
    const x = `(W-w)/2${t?.x ? `+${t.x}` : ''}${motion?.dx ? `+${motion.dx}` : ''}`
    const y = `(H-h)/2${t?.y ? `+${t.y}` : ''}${motion?.dy ? `+${motion.dy}` : ''}`
    return { x: `'${x}'`, y: `'${y}'` }
  }

  // The bottom track is laid end to end: each clip (and each gap, in black)
  // is its own stretch of whole frames, joined with `concat`. A timed
  // `overlay` per clip over one long canvas -- as before -- copied every
  // 2K frame once per clip of the run, shown or not: 13 clips made a run
  // four times slower than one. Stretches are counted on the frame grid of
  // the whole run, so hundreds of joins never drift off the sound.
  let lastLabel = ''
  const upper: ResolvedExportClip[] = []
  if (wantVideo) {
    const fps = frameRate
    const totalFrames = Math.max(1, Math.round(durationSeconds * fps))
    const bottomOrder = sortedVideo[0]?.trackOrder
    const stretches: string[] = []
    let cursor = 0
    const gap = (frames: number): void => {
      const label = `gap${stretches.length}`
      filterParts.push(`${canvas}:d=${seconds((frames + 1) / fps)},trim=end_frame=${frames}[${label}]`)
      stretches.push(label)
    }
    sortedVideo.forEach((rc, i) => {
      const from = Math.round(rc.clip.startTime * fps)
      const to = Math.min(totalFrames, Math.round((rc.clip.startTime + rc.clip.duration) * fps))
      if (rc.trackOrder !== bottomOrder || from < cursor) {
        upper.push(rc)
        return
      }
      if (to <= from) return
      if (from > cursor) gap(from - cursor)
      const frames = to - from
      const label = `s${i}`
      const input = `[${videoInputIndex.get(rc)!}:v]${clipPicture(rc).join(',')}`
      // A file that ends early (or a still image) holds its last frame, and
      // one with no frames at all leaves black -- never a shorter stretch
      // that would pull everything after it earlier.
      if (isPlainPicture(rc.clip)) {
        // Centred as it is: padded to the frame, after one black frame
        // that is dropped again (all that is left if the file gave none).
        filterParts.push(`${input},pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[c${i}]`)
        filterParts.push(`${canvas}:d=${seconds(1 / fps)},trim=end_frame=1[z${i}]`)
        filterParts.push(`[z${i}][c${i}]concat=n=2:v=1:a=0,tpad=stop_mode=clone:stop=-1,trim=start_frame=1:end_frame=${frames + 1},setpts=PTS-STARTPTS[${label}]`)
      } else {
        // Smaller, moved, turned or see-through: over black of its length.
        filterParts.push(`${canvas}:d=${seconds((frames + 1) / fps)}[bg${i}]`)
        filterParts.push(`${input}[c${i}]`)
        const at = place(rc, 't')
        filterParts.push(`[bg${i}][c${i}]overlay=x=${at.x}:y=${at.y}:eof_action=repeat,trim=end_frame=${frames}[${label}]`)
      }
      stretches.push(label)
      cursor = to
    })
    if (cursor < totalFrames) gap(totalFrames - cursor)
    if (stretches.length === 1) lastLabel = stretches[0]
    else {
      filterParts.push(`${stretches.map((l) => `[${l}]`).join('')}concat=n=${stretches.length}:v=1:a=0[lane]`)
      lastLabel = 'lane'
    }
  }
  // Higher tracks (and any overlap on the bottom one) over it, each shown
  // for its own time.
  upper.forEach((rc, i) => {
    const { clip } = rc
    const clipLabel = `v${i}`
    filterParts.push(`[${videoInputIndex.get(rc)!}:v]${[...clipPicture(rc), `setpts=PTS-STARTPTS+${clip.startTime}/TB`].join(',')}[${clipLabel}]`)
    const nextLabel = `ov${i}`
    const at = place(rc, `t-${seconds(clip.startTime)}`)
    filterParts.push(`[${lastLabel}][${clipLabel}]overlay=x=${at.x}:y=${at.y}:enable='between(t,${clip.startTime},${clip.startTime + clip.duration})'[${nextLabel}]`)
    lastLabel = nextLabel
  })
  if (wantVideo && overlay) {
    // A window of a longer export: the burned-in subtitles are timed in
    // project time, so the frames are shifted there and back around them.
    const offset = build.timeOffset ?? 0
    const shiftedIn = offset > 0 ? 'shiftedin' : lastLabel
    const steps = buildOverlayFilterSteps(shiftedIn, offset > 0 ? 'shiftedout' : 'overlaid', dimensions, overlay)
    if (steps.length > 0) {
      if (offset > 0) {
        filterParts.push(`[${lastLabel}]setpts=PTS+${offset}/TB[shiftedin]`)
        filterParts.push(...steps)
        filterParts.push(`[shiftedout]setpts=PTS-${offset}/TB[overlaid]`)
      } else filterParts.push(...steps)
      lastLabel = 'overlaid'
    }
  }
  if (wantVideo) filterParts.push(`[${lastLabel}]format=yuv420p[vout]`)

  const audioLabels: string[] = []
  if (options.includeAudio) {
    audioClips.forEach((rc, i) => {
      const idx = audioInputIndex.get(rc)!
      const { clip } = rc
      const sourceOut = sourceEnd(clip)
      const volume = clip.volume ?? 1
      const steps: string[] = build.seekInputs ? ['asetpts=PTS-STARTPTS'] : [`atrim=start=${clip.sourceIn}:end=${sourceOut}`, 'asetpts=PTS-STARTPTS']
      let remainingRate = clipRate(clip)
      while (remainingRate > 2) {
        steps.push('atempo=2')
        remainingRate /= 2
      }
      while (remainingRate < 0.5) {
        steps.push('atempo=0.5')
        remainingRate /= 0.5
      }
      if (Math.abs(remainingRate - 1) > 1e-6) steps.push(`atempo=${remainingRate}`)
      if (volume !== 1) steps.push(`volume=${volume}`)
      if (clip.fadeIn) steps.push(`afade=t=in:st=0:d=${clip.fadeIn}`)
      if (clip.fadeOut) steps.push(`afade=t=out:st=${Math.max(0, clip.duration - clip.fadeOut)}:d=${clip.fadeOut}`)
      steps.push(`adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)}`)
      const label = `a${i}`
      filterParts.push(`[${idx}:a]${steps.join(',')}[${label}]`)
      audioLabels.push(label)
    })
  }

  // Pieces of a longer export are joined end to end: each needs an audio
  // track of exactly its own length, even a stretch with nothing to hear.
  if (build.silentBed && options.includeAudio) {
    filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds(durationSeconds)}[abed]`)
    audioLabels.unshift('abed')
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
    if (build.videoCodecArgs) args.push(...build.videoCodecArgs)
    else {
      args.push('-c:v', EXPORT_CODEC_ENCODER[options.codec])
      // No GPU: the CPU encoder's quick setting too (x264 "veryfast" is
      // about three times "medium"'s speed); "Higher" keeps the default.
      if (options.bitratePreset !== 'higher' && options.codec !== 'av1') args.push('-preset', options.codec === 'h264' ? 'veryfast' : 'fast')
      if (options.bitratePreset === 'custom' && options.customBitrateKbps) {
        args.push('-b:v', `${options.customBitrateKbps}k`)
      } else if (options.bitratePreset !== 'custom') {
        args.push('-crf', String(EXPORT_BITRATE_CRF[options.bitratePreset]))
      }
    }
    args.push('-pix_fmt', 'yuv420p', '-r', String(frameRate))
  } else {
    args.push('-vn')
  }

  if (audioOutLabel) {
    // A piece keeps its sound as PCM: it is encoded once, after joining
    // (AAC per piece would leave a tiny gap at every join).
    if (build.pcmAudio) args.push('-c:a', 'pcm_s16le', '-ar', '48000')
    else args.push('-c:a', options.audioFormat === 'mp3' ? 'libmp3lame' : 'aac', '-b:a', '192k')
  } else {
    args.push('-an')
  }

  args.push('-t', String(durationSeconds))
  if (wantVideo && !build.pcmAudio) args.push('-movflags', '+faststart')
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
export function estimateOutputSizeMB(durationSeconds: number, options: Pick<ExportOptions, 'resolution' | 'bitratePreset' | 'customBitrateKbps'> & { frameRate?: number }): number {
  // 50/60 fps holds about half as much again: a 1 h 32 min 2K 60 fps export
  // came out at 9.6 Mbps, 6.4 GB, where the 30 fps figure said 2.6 GB.
  const fpsFactor = (options.frameRate ?? 30) > 30 ? 1.6 : 1
  const kbps =
    options.bitratePreset === 'custom' && options.customBitrateKbps
      ? options.customBitrateKbps
      : APPROX_KBPS_AT_CRF23[options.resolution] * CRF_SIZE_MULTIPLIER[options.bitratePreset === 'custom' ? 'recommended' : options.bitratePreset] * fpsFactor
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
  // A video clip whose audio has already been split off onto its own linked
  // audio-track clip (via the explicit "Extract to Audio" action -- see
  // sequenceOps.extractAudio; a plain video import no longer auto-creates
  // this pair, see sequenceOps.buildInsertedClips) must NOT also contribute
  // its own embedded audio track here, or that audio gets mixed into the
  // export twice (once from the video clip itself, once from its linked
  // partner) -- audibly doubled/echoing on every export that included such a
  // clip.
  const eligibleIds = new Set(eligible.map((c) => c.id))
  const audioClips = eligible.filter((c) => {
    if (c.type !== 'audio' && c.type !== 'video') return false
    // Mirrors Preview's own isTrackAudioMuted application (see
    // PreviewPlayer.tsx) -- without this, soloing/muting a track in the
    // Timeline changed what Preview played but never affected the exported
    // file, which always mixed in every track's audio regardless.
    if (isTrackAudioMuted(sequence.tracks, c.trackId)) return false
    if (c.muted) return false
    if (c.type === 'audio') return true
    const audioSplitToLinkedClip = !!c.linkedClipId && eligibleIds.has(c.linkedClipId)
    return !audioSplitToLinkedClip
  })
  return { videoClips, audioClips, tracksById }
}
