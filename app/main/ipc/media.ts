import { ipcMain, dialog, type BrowserWindow, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { mkdir, writeFile, rm, rename, readFile } from 'fs/promises'
import { join } from 'path'
import { SUPPORTED_MEDIA_EXTENSIONS, MEDIA_IPC } from '@shared/media'
import type { MediaItem, WaveformData } from '@shared/media'
import type { MediaSource } from '@shared/project'
import { detectFfmpeg, ffmpegPath } from '../media/ffmpeg'
import { processMediaFile } from '../media/pipeline'
import { cancelJob, CanceledError } from '../media/jobRunner'
import { registerMediaToken } from '../media/protocol'
import { getMediaCacheRoot, cacheKeyForFile, pathExists } from '../media/cache'

/** Waveform data lives in the same per-file cache directory as the
 * thumbnail/proxy (see pipeline.ts's shared `cacheDir`), but -- unlike those
 * two -- it was never re-read on rehydrate, so it silently disappeared every
 * time a project was reopened even though the generated `waveform.json` was
 * still sitting on disk. Recomputes the same content-hash cache key
 * `generateWaveform` originally wrote under (path+size+mtime of the ORIGINAL
 * file, not the proxy) rather than requiring a new persisted field on
 * MediaSource. Silently returns undefined if the source file's moved/missing
 * or nothing was ever cached for it (e.g. a video with no audio track). */
async function tryReadCachedWaveform(originalPath: string): Promise<WaveformData | undefined> {
  try {
    const key = await cacheKeyForFile(originalPath)
    const waveformPath = join(getMediaCacheRoot(), key, 'waveform.json')
    if (!(await pathExists(waveformPath))) return undefined
    return JSON.parse(await readFile(waveformPath, 'utf-8')) as WaveformData
  } catch {
    return undefined
  }
}

// mediaId -> original file path, so a Retry can re-run the same source file.
const retryPaths = new Map<string, string>()

/** Reconstructs one ready-to-play MediaItem from a persisted MediaSource --
 * re-registers app-media:// tokens for the files already on disk (proxy,
 * thumbnail, original) instead of re-running the whole ffmpeg pipeline,
 * since every field it needs (duration, hasAudio, paths) was already saved. */
async function rehydrateMediaSource(source: MediaSource): Promise<MediaItem> {
  return {
    id: source.id,
    kind: source.kind,
    assetType: source.assetType,
    fileName: source.fileName,
    originalPath: source.originalPath,
    originalUrl: registerMediaToken(source.originalPath),
    proxyPath: source.proxyPath,
    proxyUrl: source.proxyPath ? registerMediaToken(source.proxyPath) : undefined,
    thumbnailPath: source.thumbnailPath,
    thumbnailUrl: source.thumbnailPath ? registerMediaToken(source.thumbnailPath) : undefined,
    waveform: source.hasAudio ? await tryReadCachedWaveform(source.originalPath) : undefined,
    metadata: {
      durationSeconds: source.durationSeconds,
      hasVideo: source.kind === 'video',
      hasAudio: source.hasAudio,
      containerFormat: 'unknown',
      fileSizeBytes: 0
    },
    stage: 'ready',
    percent: 100,
    cached: true,
    addedAt: source.addedAt
  }
}

export function registerMediaIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(MEDIA_IPC.ffmpegStatus, async () => detectFfmpeg())

  ipcMain.handle(MEDIA_IPC.rehydrate, async (_event, sources: MediaSource[]) => {
    for (const source of sources) retryPaths.set(source.id, source.originalPath)
    return Promise.all(sources.map(rehydrateMediaSource))
  })

  ipcMain.handle(MEDIA_IPC.pickFiles, async () => {
    const win = getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media & Images', extensions: [...SUPPORTED_MEDIA_EXTENSIONS] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(MEDIA_IPC.importPaths, async (event, paths: string[]) => {
    for (const filePath of paths) {
      runPipeline(event.sender, filePath)
    }
  })

  ipcMain.handle(MEDIA_IPC.retryJob, async (event, mediaId: string) => {
    const filePath = retryPaths.get(mediaId)
    if (!filePath) return
    runPipeline(event.sender, filePath, mediaId)
  })

  ipcMain.handle(MEDIA_IPC.cancelJob, async (_event, mediaId: string) => {
    return cancelJob(mediaId)
  })

  ipcMain.handle(MEDIA_IPC.saveGeneratedFile, async (_event, fileName: string, data: Uint8Array) => {
    const dir = join(getMediaCacheRoot(), 'generated')
    await mkdir(dir, { recursive: true })
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const filePath = join(dir, safeName)
    await writeFile(filePath, Buffer.from(data))

    // A MediaRecorder-produced .webm (Voiceover recording) commonly leaves
    // its EBML Segment Duration unset/zero -- a live-streaming-container
    // artifact -- which ffprobe then reports downstream as a 0s duration.
    // Remuxing (no re-encode) writes a correct header before the file ever
    // reaches the shared probing pipeline every other import already
    // relies on. A PNG (Freeze Frame) never hits this branch.
    if (filePath.toLowerCase().endsWith('.webm')) {
      const fixedPath = filePath.replace(/\.webm$/i, '.fixed.webm')
      try {
        await remuxToFixDuration(filePath, fixedPath)
        await rm(filePath)
        await rename(fixedPath, filePath)
      } catch {
        // ffmpeg unavailable or remux failed -- fall back to the original
        // file; it's still playable, just with a possibly-wrong duration.
      }
    }

    return filePath
  })
}

function remuxToFixDuration(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-y', '-i', src, '-c', 'copy', dest])
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
    })
  })
}

function runPipeline(sender: WebContents, filePath: string, existingMediaId?: string): void {
  let capturedId = existingMediaId

  processMediaFile(
    filePath,
    (update) => {
      capturedId = update.mediaId
      if (update.originalPath) retryPaths.set(update.mediaId, update.originalPath)
      sender.send(MEDIA_IPC.progress, update)
    },
    existingMediaId
  ).catch((err) => {
    const mediaId = capturedId ?? existingMediaId ?? 'unknown'
    if (err instanceof CanceledError) {
      sender.send(MEDIA_IPC.progress, { mediaId, stage: 'canceled', percent: 0 })
    } else {
      sender.send(MEDIA_IPC.progress, {
        mediaId,
        stage: 'error',
        percent: 0,
        errorMessage: err instanceof Error ? err.message : String(err)
      })
    }
  })
}
