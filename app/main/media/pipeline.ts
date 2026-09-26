import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import { validateMediaFile } from './validate'
import { probeMedia } from './probe'
import { cacheKeyForFile, ensureCacheDir } from './cache'
import { generateThumbnail } from './thumbnail'
import { generateWaveform } from './waveform'
import type { WaveformData } from '@shared/media'
import { generateVideoProxy } from './proxy'
import { synthesizeVideoFromImage } from './stillImage'
import { registerMediaToken } from './protocol'
import { SUPPORTED_IMAGE_EXTENSIONS } from '@shared/media'
import type { MediaItem, MediaProgressUpdate } from '@shared/media'

export type ProgressCallback = (update: MediaProgressUpdate) => void

function isStillImagePath(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase()
  return (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

export async function processMediaFile(
  filePath: string,
  onProgress: ProgressCallback,
  existingMediaId?: string
): Promise<MediaItem> {
  const mediaId = existingMediaId ?? randomUUID()
  const fileName = basename(filePath)

  onProgress({ mediaId, stage: 'validating', percent: 0, fileName, originalPath: filePath })
  const validation = await validateMediaFile(filePath)
  if (!validation.ok) {
    throw new Error(validation.error)
  }

  const cacheKey = await cacheKeyForFile(filePath)
  const cacheDir = await ensureCacheDir(cacheKey)

  // A still image has no video/audio streams of its own -- synthesize a
  // fixed-duration silent video from it first, then feed that into the exact
  // same probe/thumbnail/proxy pipeline every real video goes through, so
  // playback, the timeline, and export never special-case images.
  const isStillImage = isStillImagePath(filePath)
  let sourcePath = filePath
  if (isStillImage) {
    onProgress({ mediaId, stage: 'probing', percent: 3, fileName, originalPath: filePath })
    const synthesized = await synthesizeVideoFromImage(mediaId, filePath, cacheDir)
    sourcePath = synthesized.outputPath
  }

  onProgress({ mediaId, stage: 'probing', percent: 5, fileName, originalPath: filePath })
  const metadata = await probeMedia(sourcePath)

  const originalUrl = registerMediaToken(sourcePath)
  const kind = metadata.hasVideo ? 'video' : 'audio'
  const assetType = isStillImage ? 'image' : kind

  // Everything the app needs to preview this asset and place it on the
  // Timeline (duration, hasAudio, a playable URL) is known the moment
  // probing finishes -- thumbnail/waveform/proxy are background polish from
  // here on, not a precondition. Marking `readyToUse` here, rather than
  // waiting for the terminal 'ready' stage, is what lets ImportPanel/
  // PreviewPlayer stop gating on the full pipeline completing.
  onProgress({ mediaId, stage: 'probing', percent: 10, fileName, originalPath: filePath, originalUrl, metadata, kind, assetType, readyToUse: true })

  let allFromCache = true
  let thumbnailPath: string | undefined
  let thumbnailUrl: string | undefined
  if (metadata.hasVideo) {
    onProgress({ mediaId, stage: 'thumbnail', percent: 15, fileName, originalPath: filePath })
    const thumb = await generateThumbnail(mediaId, sourcePath, cacheDir, metadata.durationSeconds)
    thumbnailPath = thumb.outputPath
    thumbnailUrl = registerMediaToken(thumbnailPath)
    allFromCache &&= thumb.fromCache
  }

  onProgress({ mediaId, stage: 'waveform', percent: 30, fileName, originalPath: filePath })
  // Best-effort: a waveform that can't be drawn (an odd codec, a decode
  // error) must not fail the whole import -- the clip still plays, and
  // the renderer asks again later (see MEDIA_IPC.ensureWaveform).
  let waveform: WaveformData | undefined
  if (metadata.hasAudio) {
    try {
      waveform = await generateWaveform(mediaId, sourcePath, cacheDir)
    } catch (err) {
      console.warn(`[media] waveform for ${fileName} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // A still image's "video" is a synthesized, trivially-simple looping
  // frame (see stillImage.ts) -- there's no real quality/bitrate benefit to
  // a separate lower-res proxy of that, only the cost of an extra encode
  // delaying `ready`. The synthesized video already IS the lightweight
  // asset; only real video footage gets a 480p proxy.
  let proxyPath: string | undefined
  let proxyUrl: string | undefined
  if (metadata.hasVideo && !isStillImage) {
    onProgress({ mediaId, stage: 'proxy', percent: 45, fileName, originalPath: filePath })
    const proxy = await generateVideoProxy(mediaId, sourcePath, cacheDir, metadata.durationSeconds, (p) => {
      onProgress({ mediaId, stage: 'proxy', percent: 45 + p * 0.55, fileName, originalPath: filePath })
    })
    proxyPath = proxy.outputPath
    proxyUrl = registerMediaToken(proxyPath)
    allFromCache &&= proxy.fromCache
  }

  const item: MediaItem = {
    id: mediaId,
    kind,
    assetType,
    fileName,
    originalPath: filePath,
    originalUrl,
    proxyPath,
    proxyUrl,
    thumbnailPath,
    thumbnailUrl,
    waveform,
    metadata,
    stage: 'ready',
    percent: 100,
    cached: allFromCache,
    addedAt: new Date().toISOString(),
    readyToUse: true
  }

  onProgress({ mediaId, ...item })
  return item
}
