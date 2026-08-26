import { ipcMain, dialog, BrowserWindow, type WebContents } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { TRANSCRIPTION_IPC } from '@shared/transcription'
import type { WhisperModelSize, TranscriptionLanguage, CorrectionCategory, TranscriptWord } from '@shared/transcription'
import { getDeviceInfo, retryGpuDetection, verifyGpu } from '../ai/gpuService'
import { listModelStatuses, downloadModel, cancelModelDownload } from '../ai/modelManager'
import { startTranscription, pauseTranscription, resumeTranscription, cancelTranscription } from '../ai/transcriptionService'
import { alignScript } from '../ai/alignmentService'
import {
  getCorrectionDictionary,
  addCorrectionEntry,
  updateCorrectionEntry,
  removeCorrectionEntry,
  importCorrectionDictionary,
  exportCorrectionDictionaryJson
} from '../ai/correctionDictionary'

interface StartParams {
  mediaId: string
  originalPath: string
  modelId: WhisperModelSize
  language: TranscriptionLanguage
}

// mediaId -> params, so a Retry request can re-run the exact same job.
const retryParams = new Map<string, StartParams>()

export function registerTranscriptionIpc(): void {
  ipcMain.handle(TRANSCRIPTION_IPC.getDeviceInfo, async () => getDeviceInfo())
  ipcMain.handle(TRANSCRIPTION_IPC.retryGpuDetection, async () => retryGpuDetection())
  ipcMain.handle(TRANSCRIPTION_IPC.verifyGpu, async () => verifyGpu())

  ipcMain.handle(TRANSCRIPTION_IPC.listModels, async () => listModelStatuses())

  ipcMain.handle(TRANSCRIPTION_IPC.downloadModel, async (event, modelId: WhisperModelSize) => {
    await downloadModel(modelId, (p) => {
      event.sender.send(TRANSCRIPTION_IPC.modelDownloadProgress, p)
    })
  })

  ipcMain.handle(TRANSCRIPTION_IPC.cancelModelDownload, async () => {
    cancelModelDownload()
  })

  ipcMain.handle(TRANSCRIPTION_IPC.start, async (event, params: StartParams) => {
    retryParams.set(params.mediaId, params)
    runAndForward(event.sender, params)
  })

  ipcMain.handle(TRANSCRIPTION_IPC.retry, async (event, mediaId: string) => {
    const params = retryParams.get(mediaId)
    if (!params) return
    runAndForward(event.sender, params)
  })

  ipcMain.handle(TRANSCRIPTION_IPC.pause, async () => pauseTranscription())
  ipcMain.handle(TRANSCRIPTION_IPC.resume, async () => resumeTranscription())
  ipcMain.handle(TRANSCRIPTION_IPC.cancel, async () => cancelTranscription())

  ipcMain.handle(TRANSCRIPTION_IPC.alignScript, async (_event, args: { scriptText: string; words: TranscriptWord[] }) => {
    return alignScript(args.scriptText, args.words)
  })

  ipcMain.handle(TRANSCRIPTION_IPC.getCorrectionDictionary, async () => getCorrectionDictionary())

  ipcMain.handle(
    TRANSCRIPTION_IPC.addCorrectionEntry,
    async (_event, args: { original: string; correction: string; category: CorrectionCategory; language: 'km' | 'en' | 'mixed' }) =>
      addCorrectionEntry(args.original, args.correction, args.category, args.language)
  )

  ipcMain.handle(
    TRANSCRIPTION_IPC.updateCorrectionEntry,
    async (
      _event,
      args: {
        id: string
        updates: { original?: string; correction?: string; category?: CorrectionCategory; language?: 'km' | 'en' | 'mixed'; enabled?: boolean }
      }
    ) => updateCorrectionEntry(args.id, args.updates)
  )

  ipcMain.handle(TRANSCRIPTION_IPC.removeCorrectionEntry, async (_event, id: string) => removeCorrectionEntry(id))

  ipcMain.handle(
    TRANSCRIPTION_IPC.importCorrectionDictionary,
    async (_event, args: { jsonText: string; mode: 'merge' | 'replace' }) => importCorrectionDictionary(args.jsonText, args.mode)
  )

  ipcMain.handle(TRANSCRIPTION_IPC.exportCorrectionDictionary, async () => exportCorrectionDictionaryJson())

  ipcMain.handle(TRANSCRIPTION_IPC.exportCorrectionDictionaryToFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { canceled: true }
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Correction Dictionary',
      defaultPath: 'correction-dictionary.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const json = await exportCorrectionDictionaryJson()
    await writeFile(result.filePath, json, 'utf-8')
    return { canceled: false, filePath: result.filePath }
  })

  ipcMain.handle(TRANSCRIPTION_IPC.importCorrectionDictionaryFromFile, async (event, mode: 'merge' | 'replace') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Correction Dictionary',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const jsonText = await readFile(result.filePaths[0], 'utf-8')
    const entries = await importCorrectionDictionary(jsonText, mode)
    return { canceled: false, entries }
  })
}

function runAndForward(sender: WebContents, params: StartParams): void {
  startTranscription(params.mediaId, params.originalPath, params.modelId, params.language, (update) => {
    sender.send(TRANSCRIPTION_IPC.progress, update)
  }).catch(() => {
    // Failure/cancellation is already forwarded via the onProgress stage ('error'/'canceled').
  })
}
