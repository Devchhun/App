import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { VOCAL_REMOVAL_IPC, type RemoveVocalsResult, type SpeechRange, type VocalRemovalProgress } from '@shared/vocalRemoval'
import type { VoxCpmDevice } from '@shared/dubbing'
import { removeVocals, removeVocalsWithDemucs, hasStereoAudio, hasUsableStereoWidth, VocalRemovalCanceledError } from '../media/vocalRemoval'
import { mixVocalsAtLines } from '../media/vocalsAtLines'

/** Running jobs, so Cancel can stop one. */
const running = new Map<string, AbortController>()

interface RemoveArgs {
  jobId: string
  sourcePath: string
  installDir?: string
  device?: VoxCpmDevice
}

export function registerVocalRemovalIpc(): void {
  ipcMain.handle(VOCAL_REMOVAL_IPC.cancel, async (_event, jobId: string): Promise<boolean> => {
    const controller = running.get(jobId)
    controller?.abort()
    return !!controller
  })

  // Returns a discriminated result instead of throwing: Electron serializes
  // a thrown error down to a bare Error across IPC, so a caller could never
  // tell "this file is mono" (a normal, explainable outcome the UI should
  // spell out) from "ffmpeg blew up". Same convention as app/main/ipc/ai.ts.
  const separate = async (args: RemoveArgs, send: (percent: number, stage: string) => void): Promise<RemoveVocalsResult> => {
      try {
        // Real separation first: keeps music/effects and takes only the
        // voice out, and works on mono. Only when the runtime it needs is
        // absent does the old channel-cancel trick get a turn -- and even
        // then only on a source it can actually work on, since on the
        // dual-mono audio most video carries it "removes" everything.
        if (args.installDir) {
          const controller = new AbortController()
          running.set(args.jobId, controller)
          try {
            const outputPath = await removeVocalsWithDemucs(args.jobId, args.sourcePath, { installDir: args.installDir, device: args.device ?? 'auto', onProgress: send, signal: controller.signal })
            return { ok: true, outputPath }
          } catch (err) {
            if (err instanceof VocalRemovalCanceledError) return { ok: false, error: 'Canceled', canceled: true }
            const message = err instanceof Error ? err.message : String(err)
            // A missing runtime is the one case the fallback is for; any
            // other failure is reported as-is rather than quietly degraded.
            if (!/runtime not found/i.test(message)) return { ok: false, error: message }
          } finally {
            running.delete(args.jobId)
          }
        }
        // The basic method (no VoxCPM2 runtime is set, or it is not there):
        // said on the pill, so a silent wait is not mistaken for a hang --
        // and so it is plain that this is not the real separator.
        send(0, 'Checking the audio (basic method: no VoxCPM2 runtime set)')
        if (!(await hasStereoAudio(args.sourcePath))) {
          return { ok: false, error: "This clip's audio is mono. Vocal separation needs the VoxCPM2 runtime (Settings > Voice Engine) -- the stereo-cancel fallback has nothing to work with on a mono file." }
        }
        if (!(await hasUsableStereoWidth(args.sourcePath))) {
          return {
            ok: false,
            error: "This clip's left and right channels are identical, so the stereo-cancel fallback would only produce silence. Set the VoxCPM2 runtime in Settings > Voice Engine to use the real separator."
          }
        }
        send(2, 'Removing vocals (basic method)')
        const outputPath = await removeVocals(args.jobId, args.sourcePath, (percent) => send(2 + Math.round(percent * 0.98), 'Removing vocals (basic method)'))
        send(100, 'Done')
        return { ok: true, outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
  }
  const sender = (event: IpcMainInvokeEvent, jobId: string) => (percent: number, stage: string): void => {
    const payload: VocalRemovalProgress = { jobId, percent, stage }
    if (!event.sender.isDestroyed()) event.sender.send(VOCAL_REMOVAL_IPC.progress, payload)
  }

  ipcMain.handle(VOCAL_REMOVAL_IPC.removeVocals, (event, args: RemoveArgs): Promise<RemoveVocalsResult> => separate(args, sender(event, args.jobId)))

  // The separation (kept, and shared with plain Remove Vocal), then the file's
  // own sound put back everywhere but the lines.
  ipcMain.handle(VOCAL_REMOVAL_IPC.removeVocalsAtLines, async (event, args: RemoveArgs & { ranges: SpeechRange[] }): Promise<RemoveVocalsResult> => {
    const send = sender(event, args.jobId)
    const separated = await separate(args, (percent, stage) => send(percent * 0.95, stage))
    if (!separated.ok) return separated
    const controller = new AbortController()
    running.set(args.jobId, controller)
    try {
      send(95, 'Keeping the original sound outside the lines')
      const outputPath = await mixVocalsAtLines(args.sourcePath, separated.outputPath, args.ranges, {
        signal: controller.signal,
        onProgress: (fraction) => send(95 + fraction * 5, 'Keeping the original sound outside the lines')
      })
      send(100, 'Done')
      return { ok: true, outputPath }
    } catch (err) {
      if (err instanceof VocalRemovalCanceledError) return { ok: false, error: 'Canceled', canceled: true }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      running.delete(args.jobId)
    }
  })
}
