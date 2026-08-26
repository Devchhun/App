import { ipcMain } from 'electron'
import { STORY_IPC } from '@shared/story'
import type { GenerateNarrativeGraphResult, StoryAnalysisError } from '@shared/story'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'
import { buildAnalysisPreview, analyzeStory, cancelAnalysis, ProviderError } from '../ai/storyAnalysisService'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: StoryAnalysisError }

// Same reasoning as app/main/ipc/ai.ts's toSerializableError: Electron IPC
// strips thrown-error subclass fields down to a generic Error, so every
// operation below catches internally and returns a discriminated result.
function toSerializableError(err: unknown): StoryAnalysisError {
  if (err instanceof ProviderError) {
    return { kind: err.kind, message: err.message, retryAfterSeconds: err.retryAfterSeconds }
  }
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) }
}

export function registerStoryIpc(): void {
  ipcMain.handle(STORY_IPC.previewAnalysis, async (_event, segments: TranscriptSegment[]): Promise<CloudRequestPreview> => {
    return buildAnalysisPreview(segments)
  })

  ipcMain.handle(
    STORY_IPC.analyzeStory,
    async (
      _event,
      args: { requestId: string; mediaId: string; segments: TranscriptSegment[]; mediaDurationSeconds: number; creativity: number }
    ): Promise<IpcResult<GenerateNarrativeGraphResult>> => {
      try {
        const data = await analyzeStory(args.requestId, args.mediaId, args.segments, args.mediaDurationSeconds, args.creativity)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toSerializableError(err) }
      }
    }
  )

  ipcMain.handle(STORY_IPC.cancelAnalysis, async (_event, requestId: string) => cancelAnalysis(requestId))
}
