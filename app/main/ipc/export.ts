import { ipcMain, dialog, app, BrowserWindow, type WebContents } from 'electron'
import { EXPORT_IPC } from '@shared/export'
import type { ExportOptions, ExportProgress, ExportError, ExportCapabilities } from '@shared/export'
import type { ProjectSequence } from '@shared/project'
import { runExport, exportGif, getAvailableCodecs, ExportError as ExportErrorClass, type ExportMediaInfo } from '../media/export'
import { detectFfmpeg } from '../media/ffmpeg'
import { cancelJob } from '../media/jobRunner'

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
}
