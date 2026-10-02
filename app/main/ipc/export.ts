import type { ExportOverlay } from '@shared/videoOverlay'
import { ipcMain, dialog, app, BrowserWindow, shell, type WebContents } from 'electron'
import { EXPORT_IPC } from '@shared/export'
import type { ExportOptions, ExportProgress, ExportError, ExportCapabilities } from '@shared/export'
import type { ProjectSequence } from '@shared/project'
import { runExport, exportGif, getAvailableCodecs, ExportError as ExportErrorClass, type ExportMediaInfo } from '../media/export'
import { detectFfmpeg } from '../media/ffmpeg'
import { cancelJob } from '../media/jobRunner'
import { stat, writeFile } from 'fs/promises'
import { join } from 'path'

/** A file name that is safe on Windows: no path separators or reserved
 * characters, never empty. The caller's extension is added separately. */
export function safeExportBaseName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim()
  return cleaned || 'export'
}

/** `<dir>/<base><ext>`, or `<base> (2)<ext>`, `(3)`… -- never overwrites. */
async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${base} (${Date.now()})${ext}`)
}

function toSerializableError(err: unknown): ExportError {
  if (err instanceof ExportErrorClass) return { kind: err.kind, message: err.message }
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) }
}

interface StartExportArgs {
  requestId: string
  sequence: ProjectSequence
  mediaById: Record<string, ExportMediaInfo>
  aspectRatio: '16:9' | '9:16' | '1:1'
  options: ExportOptions
  overlay?: ExportOverlay
}

function runStartExport(sender: WebContents, args: StartExportArgs): void {
  const send = (progress: ExportProgress): void => {
    if (!sender.isDestroyed()) sender.send(EXPORT_IPC.progress, progress)
  }

  void (async () => {
    try {
      const { outputPath } = await runExport({
        requestId: args.requestId,
        sequence: args.sequence,
        mediaById: args.mediaById,
        aspectRatio: args.aspectRatio,
        options: args.options,
        overlay: args.overlay,
        onProgress: (percent) => send({ requestId: args.requestId, percent, status: 'exporting' })
      })

      if (args.options.exportGif) {
        send({ requestId: args.requestId, percent: 0, status: 'exporting', message: 'Rendering GIF…' })
        const gifResult = await exportGif(args.requestId, outputPath, args.options.outputDir, args.options.name, (percent) =>
          send({ requestId: args.requestId, percent, status: 'exporting', message: 'Rendering GIF…' })
        )
        send({ requestId: args.requestId, percent: 100, status: 'success', outputPath: gifResult.outputPath })
        return
      }

      send({ requestId: args.requestId, percent: 100, status: 'success', outputPath })
    } catch (err) {
      const error = toSerializableError(err)
      send({ requestId: args.requestId, percent: 0, status: error.kind === 'canceled' ? 'canceled' : 'error', message: error.message })
    }
  })()
}

export function registerExportIpc(): void {
  ipcMain.handle(EXPORT_IPC.pickOutputDir, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, { title: 'Choose export folder', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle(EXPORT_IPC.getCapabilities, async (): Promise<ExportCapabilities> => {
    const ffmpegStatus = await detectFfmpeg()
    const availableCodecs = ffmpegStatus.ffmpeg ? await getAvailableCodecs() : []
    return { ffmpegAvailable: ffmpegStatus.ffmpeg, availableCodecs, defaultOutputDir: app.getPath('videos') }
  })

  ipcMain.handle(EXPORT_IPC.startExport, async (event, args: StartExportArgs) => {
    runStartExport(event.sender, args)
  })

  ipcMain.handle(EXPORT_IPC.cancelExport, async (_event, requestId: string) => cancelJob(requestId))

  ipcMain.handle(EXPORT_IPC.openOutput, async (_event, outputPath: string) => {
    if (!outputPath) return false
    shell.showItemInFolder(outputPath)
    return true
  })

  ipcMain.handle(
    EXPORT_IPC.writeTextFile,
    async (_event, args: { dir: string; name: string; extension: string; content: string }): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      try {
        if (!args.dir || !(await stat(args.dir)).isDirectory()) return { ok: false, error: 'The export folder does not exist.' }
        const extension = /^\.[a-z0-9]{1,8}$/i.test(args.extension) ? args.extension : '.txt'
        const path = await uniquePath(args.dir, safeExportBaseName(args.name), extension)
        // UTF-8 with a BOM: Windows tools (Notepad, older subtitle editors)
        // otherwise misread Khmer text as a legacy code page.
        await writeFile(path, `﻿${args.content}`, 'utf8')
        return { ok: true, path }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
