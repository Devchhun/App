import { existsSync } from 'fs'
import { ipcMain, dialog, type BrowserWindow, type WebContents, app } from 'electron'
import { spawn } from 'child_process'
import { mkdir, writeFile, rm, rename, readFile } from 'fs/promises'
import { extname, join } from 'path'
import { SUPPORTED_IMAGE_EXTENSIONS, SUPPORTED_MEDIA_EXTENSIONS, MEDIA_IPC } from '@shared/media'
import type { MediaItem, MediaProgressUpdate, RemoveBackgroundResult, WaveformData } from '@shared/media'
import type { MediaSource } from '@shared/project'
import { detectFfmpeg, ffmpegPath } from '../media/ffmpeg'
import { processMediaFile } from '../media/pipeline'
import { cancelJob, CanceledError } from '../media/jobRunner'
import { registerMediaToken } from '../media/protocol'
import { getMediaCacheRoot, cacheKeyForFile, ensureCacheDir, pathExists } from '../media/cache'
import { generateWaveform, WAVEFORM_CACHE_FILE } from '../media/waveform'
import { checkCachedProxy } from '../media/proxy'
import { removeImageBackground } from '../media/removeBackground'

/** A reopened project's proxies, checked one at a time in the background
 * (proxy.ts's checkCachedProxy: a few seconds each, once per proxy). A
 * damaged or missing one is dropped -- the original file plays meanwhile --
 * and made again. Media still being processed is left to its own resumed
 * pipeline, which checks its proxy the same way. */
async function checkRehydratedProxies(sender: WebContents, sources: MediaSource[]): Promise<void> {
  for (const source of sources) {
    if (source.pendingStage || source.kind !== 'video' || !source.proxyPath) continue
    if ((await checkCachedProxy(source.proxyPath)) === 'ok') continue
    if (sender.isDestroyed()) return
    sender.send(MEDIA_IPC.progress, { mediaId: source.id, stage: 'proxy', percent: 45, dropProxy: true } satisfies MediaProgressUpdate)
    if (existsSync(source.originalPath)) runPipeline(sender, source.originalPath, source.id)
  }
}

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
    const waveformPath = join(getMediaCacheRoot(), key, WAVEFORM_CACHE_FILE)
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
  // `pendingStage` means background processing hadn't finished (or had
  // failed/been canceled) when this project was last saved -- originalPath
  // plus the already-known duration/hasAudio mean it's fully usable right
  // away regardless, so `readyToUse` is always true here; `stage`/`percent`
  // just reflect what's left so the UI shows the right badge until the
  // auto-resumed pipeline (see the rehydrate handler below) reports real
  // progress of its own.
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
    stage: source.pendingStage ?? 'ready',
    percent: source.pendingStage ? 10 : 100,
    cached: true,
    addedAt: source.addedAt,
    readyToUse: true
  }
}

export function registerMediaIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(MEDIA_IPC.ffmpegStatus, async () => detectFfmpeg())

  // Remove Background: one job per picture at a time; Cancel aborts it.
  const backgroundJobs = new Map<string, AbortController>()
  ipcMain.handle(MEDIA_IPC.removeBackground, async (event, args: { jobId: string; imagePath: string }): Promise<RemoveBackgroundResult> => {
    const controller = new AbortController()
    backgroundJobs.set(args.jobId, controller)
    const send = (stage: string, percent: number): void => {
      if (!event.sender.isDestroyed()) event.sender.send(MEDIA_IPC.removeBackgroundProgress, { jobId: args.jobId, stage, percent })
    }
    try {
      return { ok: true, outputPath: await removeImageBackground(args.jobId, args.imagePath, send, controller.signal) }
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, canceled: true, error: 'Canceled' }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      backgroundJobs.delete(args.jobId)
    }
  })
  ipcMain.handle(MEDIA_IPC.cancelRemoveBackground, async (_event, jobId: string) => {
    backgroundJobs.get(jobId)?.abort()
    cancelJob(jobId)
    return true
  })

  // Only picture files, and only ones that exist: this hands out a URL
  // for a path the renderer names.
  ipcMain.handle(MEDIA_IPC.imageUrl, async (_event, filePath: string): Promise<string | null> => {
    const ext = extname(filePath ?? '').slice(1).toLowerCase()
    if (!(SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext) || !existsSync(filePath)) return null
    return registerMediaToken(filePath)
  })

  ipcMain.handle(MEDIA_IPC.rehydrate, async (event, sources: MediaSource[]) => {
    for (const source of sources) retryPaths.set(source.id, source.originalPath)
    const items = await Promise.all(sources.map(rehydrateMediaSource))
    // Automatically pick background processing back up for anything that
    // wasn't finished (or had failed/been canceled) when this project was
    // last saved -- "Save/Reopen must preserve the media and safely resume
    // unfinished processing" means this happens on its own, not only if the
    // user notices and clicks Retry. Fire-and-forget, same as a fresh
    // import: runPipeline reports its own progress over MEDIA_IPC.progress,
    // and every already-completed stage is skipped via the on-disk cache.
    for (const source of sources) {
      if (source.pendingStage) runPipeline(event.sender, source.originalPath, source.id)
    }
    void checkRehydratedProxies(event.sender, sources)
    return items
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

  ipcMain.handle(MEDIA_IPC.ensureWaveform, async (_event, args: { mediaId: string; originalPath: string }): Promise<WaveformData | null> => {
    try {
      const key = await cacheKeyForFile(args.originalPath)
      const cacheDir = await ensureCacheDir(key)
      return await generateWaveform(`waveform-${args.mediaId}`, args.originalPath, cacheDir)
    } catch {
      return null
    }
  })

  ipcMain.handle(MEDIA_IPC.getDefaultStillDir, async () => app.getPath('videos'))

  ipcMain.handle(MEDIA_IPC.saveStillFrame, async (_event, args: { dirPath: string; fileName: string; data: Uint8Array }): Promise<string> => {
    const dir = args.dirPath.trim() || app.getPath('videos')
    await mkdir(dir, { recursive: true })
    const safeName = args.fileName.replace(/[\\/:*?"<>|]+/g, '-')
    const dot = safeName.lastIndexOf('.')
    const stem = dot > 0 ? safeName.slice(0, dot) : safeName
    const ext = dot > 0 ? safeName.slice(dot) : ''
    // "name (1).jpg", "name (2).jpg"... rather than overwriting.
    let candidate = join(dir, safeName)
    for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`)
    await writeFile(candidate, Buffer.from(args.data))
    return candidate
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
  // Proxy/waveform jobs outlive a window close or reload; sending to a
  // destroyed WebContents throws "Object has been destroyed" and, from a
  // stream callback, takes the whole main process down with it.
  const send = (update: MediaProgressUpdate): void => {
    if (!sender.isDestroyed()) sender.send(MEDIA_IPC.progress, update)
  }

  processMediaFile(
    filePath,
    (update) => {
      capturedId = update.mediaId
      if (update.originalPath) retryPaths.set(update.mediaId, update.originalPath)
      send(update)
    },
    existingMediaId
  ).catch((err) => {
    const mediaId = capturedId ?? existingMediaId ?? 'unknown'
    if (err instanceof CanceledError) {
      send({ mediaId, stage: 'canceled', percent: 0 })
    } else {
      send({
        mediaId,
        stage: 'error',
        percent: 0,
        errorMessage: err instanceof Error ? err.message : String(err)
      })
    }
  })
}
