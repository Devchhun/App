import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'fs/promises'
import {
  VIDEO_STORY_NARRATION_IPC,
  narrationToSrt,
  narrationToTxt,
  type RegenerateNarrationSceneRequest,
  type StoryOutlineIpcResult,
  type StoryOutlineRequest,
  type StoryScriptRequest,
  type VideoStoryNarrationIpcResult,
  type VideoStoryNarrationRequest,
  type VideoStoryNarrationScene
} from '@shared/videoStoryNarration'
import { cancelVideoStoryNarration, generateVideoStoryNarration, regenerateVideoStoryScene } from '../ai/geminiVideoNarrationService'
import { buildStoryOutline, cancelStoryRecap, writeRecapScript } from '../ai/storyRecapService'
import { loadStoryLibrary, saveStoryLibrary } from '../ai/storyLibraryStore'
import { CanceledError } from '../media/jobRunner'
import { clearGeminiApiKey, hasGeminiApiKey, setGeminiApiKey } from '../ai/geminiApiKeyStore'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Canceled'
  return error instanceof Error ? error.message : String(error)
}

export function registerVideoStoryNarrationIpc(): void {
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.hasApiKey, () => hasGeminiApiKey())
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.setApiKey, (_event, key: string) => setGeminiApiKey(String(key ?? '')))
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.clearApiKey, () => clearGeminiApiKey())

  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.analyze, async (event, request: VideoStoryNarrationRequest): Promise<VideoStoryNarrationIpcResult> => {
    try {
      const data = await generateVideoStoryNarration(request, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(VIDEO_STORY_NARRATION_IPC.progress, progress)
      })
      return { ok: true, data }
    } catch (error) {
      const canceled = error instanceof CanceledError || (error instanceof Error && error.name === 'AbortError')
      return { ok: false, error: canceled ? 'Canceled' : errorMessage(error), canceled }
    }
  })

  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.regenerateScene, async (_event, request: RegenerateNarrationSceneRequest) => {
    try {
      return { ok: true as const, data: await regenerateVideoStoryScene(request) }
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) }
    }
  })

  const isCanceled = (error: unknown): boolean => error instanceof CanceledError || (error instanceof Error && error.name === 'AbortError')

  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.buildOutline, async (event, request: StoryOutlineRequest): Promise<StoryOutlineIpcResult> => {
    try {
      const data = await buildStoryOutline(request, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(VIDEO_STORY_NARRATION_IPC.progress, progress)
      })
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: isCanceled(error) ? 'Canceled' : errorMessage(error), canceled: isCanceled(error) }
    }
  })

  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.writeScript, async (event, request: StoryScriptRequest): Promise<VideoStoryNarrationIpcResult> => {
    try {
      const data = await writeRecapScript(request, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(VIDEO_STORY_NARRATION_IPC.progress, progress)
      })
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: isCanceled(error) ? 'Canceled' : errorMessage(error), canceled: isCanceled(error) }
    }
  })

  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.libraryGet, () => loadStoryLibrary())
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.librarySave, (_event, library: unknown) => saveStoryLibrary(library))

  // Either kind of job: the chunk narration or the story-first recap.
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.cancel, (_event, jobId: string) => cancelStoryRecap(jobId) || cancelVideoStoryNarration(jobId))

  const exportResult = async (event: Electron.IpcMainInvokeEvent, format: 'txt' | 'srt', scenes: VideoStoryNarrationScene[]): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: `Export Video Story Narration ${format.toUpperCase()}`,
      defaultPath: `video-story-narration.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, format === 'srt' ? narrationToSrt(scenes) : narrationToTxt(scenes), 'utf8')
    return result.filePath
  }
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.exportTxt, (event, scenes: VideoStoryNarrationScene[]) => exportResult(event, 'txt', scenes))
  ipcMain.handle(VIDEO_STORY_NARRATION_IPC.exportSrt, (event, scenes: VideoStoryNarrationScene[]) => exportResult(event, 'srt', scenes))
}
