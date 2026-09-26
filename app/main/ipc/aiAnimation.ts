import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile } from 'fs/promises'
import { basename, relative, resolve } from 'path'
import { AI_ANIMATION_IPC, type AnimationIpcResult, type AnimationRequest } from '@shared/aiAnimation'
import { animationsDir, cancelAnimation, generateAnimation } from '../animation/kuanimationService'
import { CanceledError } from '../media/jobRunner'

export function registerAiAnimationIpc(): void {
  ipcMain.handle(AI_ANIMATION_IPC.generate, async (event, request: AnimationRequest): Promise<AnimationIpcResult> => {
    try {
      const data = await generateAnimation(request, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(AI_ANIMATION_IPC.progress, progress)
      })
      return { ok: true, data }
    } catch (error) {
      const canceled = error instanceof CanceledError || (error instanceof Error && (error.name === 'AbortError' || error.message === 'Canceled'))
      // The film's folder comes back so the job can continue where it stopped.
      const folder = (error as { folder?: unknown })?.folder
      return { ok: false, error: canceled ? 'Canceled' : error instanceof Error ? error.message : String(error), canceled, ...(typeof folder === 'string' ? { folder } : {}) }
    }
  })
  ipcMain.handle(AI_ANIMATION_IPC.cancel, (_event, jobId: string) => cancelAnimation(String(jobId)))
  // Only what the app made for animations can be opened or copied from here.
  const insideAnimations = (path: string): string | null => {
    const root = animationsDir()
    const target = resolve(String(path ?? ''))
    const inside = relative(root, target)
    return !inside || inside.startsWith('..') || resolve(root, inside) !== target ? null : target
  }
  ipcMain.handle(AI_ANIMATION_IPC.openFolder, async (_event, folder: string) => {
    const target = insideAnimations(folder)
    return target ? (await shell.openPath(target)) === '' : false
  })
  ipcMain.handle(AI_ANIMATION_IPC.saveSrt, async (event, srtPath: string): Promise<string | null> => {
    const source = insideAnimations(srtPath)
    if (!source || !source.toLowerCase().endsWith('.srt')) return null
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Save SRT', defaultPath: basename(source), filters: [{ name: 'SRT subtitles', extensions: ['srt'] }] }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await copyFile(source, result.filePath)
    return result.filePath
  })
}
