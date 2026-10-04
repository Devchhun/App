// Shared media import/processing types, used by the main process, preload
// bridge, and renderer UI (Phase B).

export const SUPPORTED_VIDEO_AUDIO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'mkv'] as const
/** Still images are imported like any other clip -- see stillImage.ts, which
 * synthesizes a fixed-duration silent video from the image on import so
 * playback, the timeline, proxy generation, and export never special-case
 * images; they only ever see a real video file. */
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp'] as const
export const SUPPORTED_MEDIA_EXTENSIONS = [...SUPPORTED_VIDEO_AUDIO_EXTENSIONS, ...SUPPORTED_IMAGE_EXTENSIONS] as const

export type MediaKind = 'video' | 'audio'

export interface MediaMetadata {
  durationSeconds: number
  width?: number
  height?: number
  frameRate?: number
  videoCodec?: string
  /** ffprobe's pix_fmt (yuv420p, yuv420p10le...). */
  videoPixelFormat?: string
  audioCodec?: string
  hasVideo: boolean
  hasAudio: boolean
  containerFormat: string
  fileSizeBytes: number
}

const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1'])
/** 8-bit 4:2:0 -- what Chromium's (hardware) decoders take. */
const BROWSER_PIXEL_FORMAT = /^(yuv420p|yuvj420p|nv12)$/

/** Whether a video needs the lighter 480p preview copy (proxy) to play and
 * scrub smoothly in the editor -- or is fine as it is, as CapCut uses it.
 * Every video used to get one: a 47-minute 2560x1440 H.264 file sat at
 * "48%" for minutes before it was ready, though Chromium plays it directly.
 * Kept for what Chromium cannot decode smoothly or at all: HEVC, ProRes,
 * 10-bit, H.264 in MKV, 4K, above 60 fps. */
export function needsPreviewProxy(metadata: MediaMetadata): boolean {
  if (!metadata.hasVideo) return false
  const codec = metadata.videoCodec ?? ''
  if (!BROWSER_VIDEO_CODECS.has(codec)) return true
  if (metadata.videoPixelFormat && !BROWSER_PIXEL_FORMAT.test(metadata.videoPixelFormat)) return true
  // MP4/MOV for any of them; Matroska/WebM only for the WebM codecs.
  const container = metadata.containerFormat
  const inMp4 = /mov|mp4/.test(container)
  const inWebm = /webm|matroska/.test(container) && codec !== 'h264'
  if (!inMp4 && !inWebm) return true
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height) return true
  if (Math.max(width, height) > 2560 || Math.min(width, height) > 1440) return true
  return (metadata.frameRate ?? 30) > 61
}

/** Templates > My Logos: a logo saved for every project. */
export interface LogoTemplate {
  id: string
  name: string
  /** The app's own copy of the picture. */
  path: string
  /** For <img>. */
  url: string
}

export type MediaProcessingStage =
  | 'queued'
  | 'validating'
  | 'probing'
  | 'thumbnail'
  | 'waveform'
  | 'proxy'
  | 'ready'
  | 'error'
  | 'canceled'

export interface WaveformData {
  /** Interleaved [min, max] pairs per bucket, normalized to -1..1 */
  peaks: number[]
  sampleRate: number
  bucketCount: number
}

export interface MediaItem {
  id: string
  kind: MediaKind
  /** Which real-world asset kind this came from -- see
   * shared/project.ts's MediaSource.assetType doc comment (a still image is
   * imported by synthesizing a short silent video from it, so `kind` stays
   * 'video' while `assetType` records that it's really an image). */
  assetType?: 'video' | 'image' | 'audio'
  fileName: string
  originalPath: string
  originalUrl: string
  proxyPath?: string
  proxyUrl?: string
  thumbnailPath?: string
  thumbnailUrl?: string
  waveform?: WaveformData
  metadata?: MediaMetadata
  stage: MediaProcessingStage
  percent: number
  errorMessage?: string
  cached: boolean
  addedAt: string
  /** True as soon as `originalUrl`/`metadata` are known (right after probing
   * completes) -- everything after that point (thumbnail/waveform/proxy) is
   * pure background enhancement, not a precondition for previewing the
   * asset or adding it to the Timeline off the original file. Distinct from
   * `stage === 'ready'`, which additionally requires every background job to
   * have finished; UI that gates "can this be used at all" should check this
   * instead of waiting for the terminal stage. */
  readyToUse: boolean
}

export interface MediaProgressUpdate extends Partial<MediaItem> {
  mediaId: string
  stage: MediaProcessingStage
  percent: number
  /** The proxy on record was damaged or missing and has been discarded:
   * play the original until the new one arrives with the final update. */
  dropProxy?: boolean
}

export interface FfmpegAvailability {
  ffmpeg: boolean
  ffprobe: boolean
  ffmpegVersion?: string
  ffprobeVersion?: string
  error?: string
}

export const MEDIA_IPC = {
  pickFiles: 'media:pickFiles',
  importPaths: 'media:importPaths',
  cancelJob: 'media:cancelJob',
  retryJob: 'media:retryJob',
  progress: 'media:progress',
  ffmpegStatus: 'media:ffmpegStatus',
  /** Reconstructs ready-to-play MediaItems (fresh app-media:// tokens) from a
   * loaded project's persisted MediaSource[] -- re-registers protocol tokens
   * for the already-processed proxy/thumbnail/original files on disk without
   * re-running ffmpeg probing, since every field it needs was already saved. */
  rehydrate: 'media:rehydrate',
  /** A URL for an imported still image's own file: its media plays from a
   * video made of it (no transparency, and an <img> cannot show a video). */
  imageUrl: 'media:imageUrl',
  /** Remove Background on a still image (app/main/media/removeBackground.ts):
   * the cut-out PNG's path, progress pushed on removeBackgroundProgress. */
  removeBackground: 'media:removeBackground',
  cancelRemoveBackground: 'media:cancelRemoveBackground',
  removeBackgroundProgress: 'media:removeBackgroundProgress',
  /** Writes renderer-generated bytes (a Freeze Frame PNG, a Voiceover
   * recording) to a real file under the project-managed media cache and
   * returns its path -- the renderer then feeds that path through the exact
   * same importPaths pipeline every imported file already goes through,
   * rather than a parallel ingest path. */
  saveGeneratedFile: 'media:saveGeneratedFile',
  /** Timeline > Cover > Choose image: pick a picture (the thumbnail made
   * for the video) and get back the path of the app's own copy of it --
   * null when nothing was picked. */
  pickCoverImage: 'media:pickCoverImage',
  /** Templates > My Logos: the logos saved for every project (the app's
   * own copies, in its data folder). */
  listLogoTemplates: 'media:listLogoTemplates',
  /** Pick a picture and save it as a logo template; null when nothing was picked. */
  addLogoTemplate: 'media:addLogoTemplate',
  removeLogoTemplate: 'media:removeLogoTemplate',
  /** Player's "Export still frames": writes an encoded image to a folder
   * the user chose (default: the system Videos folder), never colliding
   * with an existing file. */
  saveStillFrame: 'media:saveStillFrame',
  /** Returns the cached waveform for a file, generating it if it is
   * missing (a failed/interrupted background job, an older project) --
   * the Timeline asks for this when an audio clip has none to draw. */
  ensureWaveform: 'media:ensureWaveform',
  getDefaultStillDir: 'media:getDefaultStillDir'
} as const

/** Remove Background's result for one picture. */
export type RemoveBackgroundResult = { ok: true; outputPath: string } | { ok: false; error: string; canceled?: boolean }

export interface RemoveBackgroundProgress {
  jobId: string
  stage: string
  percent: number
}
