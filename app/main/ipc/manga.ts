import { BrowserWindow, dialog, ipcMain } from 'electron'
import { MANGA_IPC, sortPanelPaths, type MangaEpisodesResult, type MangaIpcResult, type MangaProgress, type MangaRequest, type MangaScenesResult } from '@shared/mangaRecap'
import { SUPPORTED_IMAGE_EXTENSIONS } from '@shared/media'
import { cancelManga, generateManga } from '../manga/mangaRecapService'
import { cutIntoScenes, downloadChapter, listEpisodes, makeBackdrops } from '../manga/mangaChapter'
import { CanceledError, cancelJob } from '../media/jobRunner'
import { registerMediaToken } from '../media/protocol'
import { existsSync } from 'fs'
import { extname } from 'path'

/** Chapter downloads and cuts that can be stopped, by job id. */
const chapterJobs = new Map<string, AbortController>()

function isCanceled(error: unknown): boolean {
  return error instanceof CanceledError || (error instanceof Error && (error.name === 'AbortError' || error.message === 'Canceled'))
}

export function registerMangaIpc(): void {
  // The panels in reading order (numbers in file names read as numbers).
  ipcMain.handle(MANGA_IPC.pickImages, async (event): Promise<string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Manga panels', properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>, filters: [{ name: 'Images', extensions: [...SUPPORTED_IMAGE_EXTENSIONS] }] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : sortPanelPaths(result.filePaths)
  })
  // The panel grid's pictures: only image files that are there.
  ipcMain.handle(MANGA_IPC.thumbs, (_event, paths: unknown): string[] => {
    if (!Array.isArray(paths)) return []
    const images = new Set(SUPPORTED_IMAGE_EXTENSIONS.map((e) => `.${String(e).replace(/^\./, '').toLowerCase()}`))
    return paths.map((p) => (typeof p === 'string' && images.has(extname(p).toLowerCase()) && existsSync(p) ? registerMediaToken(p) : ''))
  })
  ipcMain.handle(MANGA_IPC.episodes, async (_event, link: unknown): Promise<MangaEpisodesResult> => {
    try {
      const { title, episodes } = await listEpisodes(String(link ?? ''))
      return { ok: true, title, episodes }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(MANGA_IPC.generate, async (event, request: MangaRequest): Promise<MangaIpcResult> => {
    try {
      const data = await generateManga(request, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(MANGA_IPC.progress, progress)
      })
      return { ok: true, data }
    } catch (error) {
      const canceled = error instanceof CanceledError || (error instanceof Error && (error.name === 'AbortError' || error.message === 'Canceled'))
      return { ok: false, error: canceled ? 'Canceled' : error instanceof Error ? error.message : String(error), canceled }
    }
  })
  // A chapter link -> its pictures -> scenes (a webtoon strip cut at its gutters).
  ipcMain.handle(MANGA_IPC.getChapter, async (event, jobId: string, pageUrl: string): Promise<MangaScenesResult> => {
    const controller = new AbortController()
    chapterJobs.set(jobId, controller)
    const send = (progress: MangaProgress): void => { if (!event.sender.isDestroyed()) event.sender.send(MANGA_IPC.progress, progress) }
    try {
      const chapter = await downloadChapter(String(pageUrl ?? ''), (done, total) => send({ jobId, phase: 'downloading', percent: Math.round((done / total) * 60), message: `Downloading picture ${done} of ${total}…` }), controller.signal)
      const paths = await cutIntoScenes(jobId, chapter.paths, (done, total) => send({ jobId, phase: 'cutting', percent: 60 + Math.round((done / total) * 40), message: 'Cutting the strip into scenes…' }), controller.signal)
      return { ok: true, title: chapter.title, paths }
    } catch (error) {
      return { ok: false, error: isCanceled(error) ? 'Canceled' : error instanceof Error ? error.message : String(error), canceled: isCanceled(error) }
    } finally {
      chapterJobs.delete(jobId)
    }
  })
  ipcMain.handle(MANGA_IPC.cutScenes, async (event, jobId: string, paths: string[]): Promise<MangaScenesResult> => {
    const controller = new AbortController()
    chapterJobs.set(jobId, controller)
    try {
      const out = await cutIntoScenes(jobId, Array.isArray(paths) ? paths.map(String) : [], (done, total) => {
        if (!event.sender.isDestroyed()) event.sender.send(MANGA_IPC.progress, { jobId, phase: 'cutting', percent: Math.round((done / total) * 100), message: 'Cutting into scenes…' } satisfies MangaProgress)
      }, controller.signal)
      return { ok: true, title: '', paths: out }
    } catch (error) {
      return { ok: false, error: isCanceled(error) ? 'Canceled' : error instanceof Error ? error.message : String(error), canceled: isCanceled(error) }
    } finally {
      chapterJobs.delete(jobId)
    }
  })
  ipcMain.handle(MANGA_IPC.backdrops, async (_event, jobId: string, paths: string[]): Promise<string[]> => makeBackdrops(String(jobId), Array.isArray(paths) ? paths.map(String) : []).catch(() => []))
  ipcMain.handle(MANGA_IPC.cancel, (_event, jobId: string) => {
    const chapter = chapterJobs.get(String(jobId))
    if (chapter) {
      chapter.abort()
      cancelJob(String(jobId))
      return true
    }
    return cancelManga(String(jobId))
  })
}
