import { ipcMain } from 'electron'
import { VOCAL_REMOVAL_IPC, type RemoveVocalsResult, type VocalRemovalProgress } from '@shared/vocalRemoval'
import type { VoxCpmDevice } from '@shared/dubbing'
import { removeVocals, removeVocalsWithDemucs, hasStereoAudio, hasUsableStereoWidth } from '../media/vocalRemoval'

export function registerVocalRemovalIpc(): void {
  // Returns a discriminated result instead of throwing: Electron serializes
  // a thrown error down to a bare Error across IPC, so a caller could never
  // tell "this file is mono" (a normal, explainable outcome the UI should
  // spell out) from "ffmpeg blew up". Same convention as app/main/ipc/ai.ts.
  ipcMain.handle(
    VOCAL_REMOVAL_IPC.removeVocals,
    async (event, args: { jobId: string; sourcePath: string; installDir?: string; device?: VoxCpmDevice }): Promise<RemoveVocalsResult> => {
      const send = (percent: number, stage: string): void => {
        const payload: VocalRemovalProgress = { jobId: args.jobId, percent, stage }
        if (!event.sender.isDestroyed()) event.sender.send(VOCAL_REMOVAL_IPC.progress, payload)
      }
      try {
        // Real separation first: keeps music/effects and takes only the
        // voice out, and works on mono. Only when the runtime it needs is
        // absent does the old channel-cancel trick get a turn -- and even
        // then only on a source it can actually work on, since on the
        // dual-mono audio most video carries it "removes" everything.
        if (args.installDir) {
          try {
            const outputPath = await removeVocalsWithDemucs(args.jobId, args.sourcePath, { installDir: args.installDir, device: args.device ?? 'auto', onProgress: send })
            return { ok: true, outputPath }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            // A missing runtime is the one case the fallback is for; any
            // other failure is reported as-is rather than quietly degraded.
            if (!/runtime not found/i.test(message)) return { ok: false, error: message }
          }
        }
        if (!(await hasStereoAudio(args.sourcePath))) {
          return { ok: false, error: "This clip's audio is mono. Vocal separation needs the VoxCPM2 runtime (Settings > Voice Engine) -- the stereo-cancel fallback has nothing to work with on a mono file." }
        }
        if (!(await hasUsableStereoWidth(args.sourcePath))) {
          return {
            ok: false,
            error: "This clip's left and right channels are identical, so the stereo-cancel fallback would only produce silence. Set the VoxCPM2 runtime in Settings > Voice Engine to use the real separator."
          }
        }
        const outputPath = await removeVocals(args.jobId, args.sourcePath)
        return { ok: true, outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
