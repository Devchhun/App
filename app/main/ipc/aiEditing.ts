import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readdir } from 'fs/promises'
import { extname, join } from 'path'
import { AI_EDIT_IPC, type AiEditProgress, type TrainingProject, type TrainingProjectSummary } from '@shared/aiEditing'
import { SUPPORTED_VIDEO_AUDIO_EXTENSIONS } from '@shared/media'

const VIDEO_EXTS = new Set(SUPPORTED_VIDEO_AUDIO_EXTENSIONS.map((e) => `.${e}`))
import type { TranscribeModel } from '../ai/editLearningService'
import type { AutoEditResult } from '@shared/autoEdit'
import { addPair, addPairs, analyzePair, autoEditPlan, AiEditCanceled, cancelAnalyze, createProject, removePair, transcribeNarration } from '../ai/editLearningService'
import { deleteProject, listProjects, loadProject, saveProject } from '../ai/editLearningStore'

type Result<T> = { ok: true; data: T } | { ok: false; error: string; canceled?: boolean }

function fail(error: unknown): { ok: false; error: string; canceled?: boolean } {
  const canceled = error instanceof AiEditCanceled || (error instanceof Error && error.message === 'Canceled')
  return { ok: false, error: canceled ? 'Canceled' : error instanceof Error ? error.message : String(error), canceled }
}

export function registerAiEditingIpc(): void {
  ipcMain.handle(AI_EDIT_IPC.listProjects, async (): Promise<Result<TrainingProjectSummary[]>> => {
    try {
      return { ok: true, data: await listProjects() }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(AI_EDIT_IPC.createProject, async (_e, name: unknown): Promise<Result<TrainingProject>> => {
    try {
      return { ok: true, data: await createProject(String(name ?? '')) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(AI_EDIT_IPC.getProject, async (_e, id: unknown): Promise<Result<TrainingProject | null>> => {
    try {
      return { ok: true, data: await loadProject(String(id ?? '')) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(AI_EDIT_IPC.deleteProject, async (_e, id: unknown): Promise<Result<true>> => {
    try {
      await deleteProject(String(id ?? ''))
      return { ok: true, data: true }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(AI_EDIT_IPC.renameProject, async (_e, id: unknown, name: unknown): Promise<Result<TrainingProject>> => {
    try {
      const project = await loadProject(String(id ?? ''))
      if (!project) throw new Error('That training project no longer exists.')
      project.name = String(name ?? '').trim() || project.name
      return { ok: true, data: await saveProject(project) }
    } catch (error) {
      return fail(error)
    }
  })

  // One video file (original or edited); the renderer labels which.
  ipcMain.handle(AI_EDIT_IPC.pickVideo, async (event, title: unknown): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: String(title ?? 'Choose a video'),
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Videos', extensions: [...SUPPORTED_VIDEO_AUDIO_EXTENSIONS] }],
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Several video files at once (originals or edits).
  ipcMain.handle(AI_EDIT_IPC.pickVideos, async (event, title: unknown): Promise<string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: String(title ?? 'Choose videos'),
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: 'Videos', extensions: [...SUPPORTED_VIDEO_AUDIO_EXTENSIONS] }],
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  // Every video in a chosen folder, sorted naturally (EP1, EP2, … EP10) so two
  // folders pair up in order.
  ipcMain.handle(AI_EDIT_IPC.pickVideoFolder, async (event, title: unknown): Promise<string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: String(title ?? 'Choose a folder of videos'), properties: ['openDirectory'] as Array<'openDirectory'> }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return []
    const dir = result.filePaths[0]
    try {
      const names = (await readdir(dir)).filter((n) => VIDEO_EXTS.has(extname(n).toLowerCase()))
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      return names.map((n) => join(dir, n))
    } catch {
      return []
    }
  })

  ipcMain.handle(AI_EDIT_IPC.addPairs, async (_e, projectId: unknown, originals: unknown, editeds: unknown): Promise<Result<TrainingProject>> => {
    try {
      const o = Array.isArray(originals) ? originals.map(String) : []
      const e = Array.isArray(editeds) ? editeds.map(String) : []
      return { ok: true, data: await addPairs(String(projectId ?? ''), o, e) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    AI_EDIT_IPC.addPair,
    async (_e, projectId: unknown, original: unknown, edited: unknown, options: unknown): Promise<Result<TrainingProject>> => {
      try {
        const opts = (options ?? {}) as { name?: string; narrationAudioPath?: string; scriptPath?: string }
        return { ok: true, data: await addPair(String(projectId ?? ''), String(original ?? ''), String(edited ?? ''), opts) }
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle(AI_EDIT_IPC.removePair, async (_e, projectId: unknown, pairId: unknown): Promise<Result<TrainingProject>> => {
    try {
      return { ok: true, data: await removePair(String(projectId ?? ''), String(pairId ?? '')) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(AI_EDIT_IPC.analyzePair, async (event, projectId: unknown, pairId: unknown): Promise<Result<TrainingProject>> => {
    try {
      const data = await analyzePair(String(projectId ?? ''), String(pairId ?? ''), (progress: AiEditProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send(AI_EDIT_IPC.progress, progress)
      })
      return { ok: true, data }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    AI_EDIT_IPC.transcribeNarration,
    async (event, projectId: unknown, pairId: unknown, modelId: unknown): Promise<Result<TrainingProject>> => {
      try {
        const model = (['tiny', 'base', 'small', 'medium', 'large-v3', 'gemini'].includes(modelId as string) ? modelId : 'small') as TranscribeModel
        const data = await transcribeNarration(String(projectId ?? ''), String(pairId ?? ''), model, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(AI_EDIT_IPC.progress, progress)
        })
        return { ok: true, data }
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle(
    AI_EDIT_IPC.autoEdit,
    async (event, projectId: unknown, sourceVideoPath: unknown, narrationPath: unknown, modelId: unknown): Promise<Result<AutoEditResult>> => {
      try {
        const model = (['tiny', 'base', 'small', 'medium', 'large-v3', 'gemini'].includes(modelId as string) ? modelId : 'small') as TranscribeModel
        const data = await autoEditPlan(String(projectId ?? ''), String(sourceVideoPath ?? ''), String(narrationPath ?? ''), model, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(AI_EDIT_IPC.progress, progress)
        })
        return { ok: true, data }
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle(AI_EDIT_IPC.cancelAnalyze, (_e, pairId: unknown): boolean => cancelAnalyze(String(pairId ?? '')))
}
