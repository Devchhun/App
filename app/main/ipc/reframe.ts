import { ipcMain } from 'electron'
import { REFRAME_IPC, type ReframeAnalyzeResult, type ReframeProgress } from '@shared/reframe'
import { analyzeReframe } from '../ai/reframeService'

/** Running looks, so Cancel can stop one. */
const running = new Map<string, AbortController>()

export function registerReframeIpc(): void {
  ipcMain.handle(REFRAME_IPC.cancel, async (_event, jobId: string): Promise<boolean> => {
    const controller = running.get(jobId)
    controller?.abort()
    return !!controller
  })

  ipcMain.handle(REFRAME_IPC.analyze, async (event, args: { jobId: string; path: string }): Promise<ReframeAnalyzeResult> => {
    const controller = new AbortController()
    running.set(args.jobId, controller)
    const send = (fraction: number): void => {
      const payload: ReframeProgress = { jobId: args.jobId, percent: Math.round(Math.min(1, Math.max(0, fraction)) * 100) }
      if (!event.sender.isDestroyed()) event.sender.send(REFRAME_IPC.progress, payload)
    }
    try {
      return { ok: true, analysis: await analyzeReframe(args.path, send, controller.signal) }
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: 'Canceled', canceled: true }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      running.delete(args.jobId)
    }
  })
}
