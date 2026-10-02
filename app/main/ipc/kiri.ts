import { BrowserWindow, dialog, ipcMain } from 'electron'
import { KIRI_IPC, type KiriCloneOptions, type KiriCloneResult, type KiriCloneSource, type KiriListResult } from '@shared/kiriTts'
import { basename } from 'path'
import { probeMedia } from '../media/probe'
import { SUPPORTED_MEDIA_EXTENSIONS } from '@shared/media'
import { clearKiriApiKey, hasKiriApiKey, setKiriApiKey } from '../ai/kiriApiKeyStore'
import { kiriCloneVoice, kiriListVoices } from '../media/kiriTts'

export function registerKiriIpc(): void {
  ipcMain.handle(KIRI_IPC.hasKey, () => hasKiriApiKey())
  ipcMain.handle(KIRI_IPC.setKey, (_event, key: string) => setKiriApiKey(String(key ?? '')))
  ipcMain.handle(KIRI_IPC.clearKey, () => clearKiriApiKey())
  ipcMain.handle(KIRI_IPC.listVoices, async (): Promise<KiriListResult> => {
    try {
      return { ok: true, voices: await kiriListVoices() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Clone: a recording (or a video -- its sound is used), picked here when
  // the caller has none, then uploaded.
  ipcMain.handle(KIRI_IPC.pickCloneSource, async (event): Promise<KiriCloneSource> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a recording or video of the voice',
        properties: ['openFile'],
        filters: [{ name: 'Audio or video', extensions: [...SUPPORTED_MEDIA_EXTENSIONS, 'flac', 'ogg', 'aac'] }]
      }
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
      const path = picked.filePaths[0]
      const { durationSeconds } = await probeMedia(path)
      return { ok: true, path, fileName: basename(path), durationSeconds }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(KIRI_IPC.cloneVoice, async (event, args: { name: string; sourcePath?: string; options?: KiriCloneOptions }): Promise<KiriCloneResult> => {
    try {
      let sourcePath = args.sourcePath
      if (!sourcePath) {
        const win = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = {
          title: 'Choose a recording of the voice (10-30 seconds of clear speech)',
          properties: ['openFile'],
          filters: [{ name: 'Audio or video', extensions: [...SUPPORTED_MEDIA_EXTENSIONS, 'flac', 'ogg', 'aac'] }]
        }
        const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'Canceled', canceled: true }
        sourcePath = picked.filePaths[0]
      }
      return { ok: true, voice: await kiriCloneVoice(args.name, sourcePath, args.options) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
