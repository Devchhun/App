import { ipcMain } from 'electron'
import { NARRATION_IPC } from '@shared/narration'
import type { NarrationOptimizationSettings } from '@shared/narration'
import { detectSpeakerFromAudio } from '../media/speakerDetect'
import { optimizeNarrationTake } from '../media/narrationAudio'

export function registerNarrationIpc(): void {
  ipcMain.handle(
    NARRATION_IPC.detectSpeaker,
    async (_event, args: { jobId: string; sourcePath: string; startTime: number; endTime: number }) =>
      detectSpeakerFromAudio(args.jobId, args.sourcePath, args.startTime, args.endTime)
  )

  ipcMain.handle(
    NARRATION_IPC.optimizeTake,
    async (_event, args: { jobId: string; filePath: string; settings: NarrationOptimizationSettings }) =>
      optimizeNarrationTake(args.jobId, args.filePath, args.settings)
  )
}
