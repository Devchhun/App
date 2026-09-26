import { ipcMain } from 'electron'
import { TRANSLATION_IPC } from '@shared/translation'
import type { TranslateSubtitlesResult, TranslationError } from '@shared/translation'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'
import { buildTranslationPreview, translateSubtitles, cancelTranslationRequest, ProviderError } from '../ai/translationService'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: TranslationError }

// Same reason as ai.ts's own identical comment: Electron IPC serializes
// thrown errors down to a generic Error (message + stack only), so
// ProviderError.kind wouldn't survive the crossing if this just threw.
function toSerializableError(err: unknown): TranslationError {
  if (err instanceof ProviderError) {
    return { kind: err.kind, message: err.message, retryAfterSeconds: err.retryAfterSeconds }
  }
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) }
}

export function registerTranslationIpc(): void {
  ipcMain.handle(TRANSLATION_IPC.previewTranslation, async (_event, segments: TranscriptSegment[]): Promise<CloudRequestPreview> => buildTranslationPreview(segments))

  ipcMain.handle(
    TRANSLATION_IPC.translateSubtitles,
    async (_event, args: { requestId: string; segments: TranscriptSegment[]; targetLanguage: string }): Promise<IpcResult<TranslateSubtitlesResult>> => {
      try {
        const data = await translateSubtitles(args.requestId, args.segments, args.targetLanguage)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toSerializableError(err) }
      }
    }
  )

  ipcMain.handle(TRANSLATION_IPC.cancelTranslation, async (_event, requestId: string) => cancelTranslationRequest(requestId))
}
