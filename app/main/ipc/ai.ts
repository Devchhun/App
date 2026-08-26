import { ipcMain } from 'electron'
import { AI_IPC } from '@shared/suggestions'
import type { AiSuggestion, GenerateSuggestionsError, GenerateSuggestionsResult } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'
import { hasApiKey, setApiKey, clearApiKey } from '../ai/apiKeyStore'
import {
  buildCloudRequestPreview,
  generateSuggestions,
  regenerateOne,
  simplifySuggestionText,
  cancelRequest,
  ProviderError
} from '../ai/suggestionsService'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: GenerateSuggestionsError }

// IMPORTANT: Electron IPC serializes thrown errors down to a generic Error
// (message + stack only) -- custom subclass fields like ProviderError.kind
// do NOT survive the crossing. Every AI operation below therefore catches
// internally and returns a discriminated result instead of throwing, so the
// renderer can reliably distinguish auth/rate-limit/network/timeout/etc.
function toSerializableError(err: unknown): GenerateSuggestionsError {
  if (err instanceof ProviderError) {
    return { kind: err.kind, message: err.message, retryAfterSeconds: err.retryAfterSeconds }
  }
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) }
}

export function registerAiIpc(): void {
  ipcMain.handle(AI_IPC.hasApiKey, async () => hasApiKey())

  ipcMain.handle(AI_IPC.setApiKey, async (_event, key: string) => {
    await setApiKey(key)
  })

  ipcMain.handle(AI_IPC.clearApiKey, async () => {
    await clearApiKey()
  })

  ipcMain.handle(AI_IPC.previewCloudRequest, async (_event, segments: TranscriptSegment[]) => {
    return buildCloudRequestPreview(segments)
  })

  ipcMain.handle(
    AI_IPC.generateSuggestions,
    async (
      _event,
      args: { requestId: string; mediaId: string; segments: TranscriptSegment[]; forceRegenerate: boolean }
    ): Promise<IpcResult<GenerateSuggestionsResult>> => {
      try {
        const data = await generateSuggestions(args.requestId, args.mediaId, args.segments, args.forceRegenerate)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toSerializableError(err) }
      }
    }
  )

  ipcMain.handle(AI_IPC.cancelRequest, async (_event, requestId: string) => cancelRequest(requestId))

  ipcMain.handle(
    AI_IPC.regenerateSuggestion,
    async (
      _event,
      args: { requestId: string; mediaId: string; segment: TranscriptSegment }
    ): Promise<IpcResult<AiSuggestion | null>> => {
      try {
        const data = await regenerateOne(args.requestId, args.mediaId, args.segment)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toSerializableError(err) }
      }
    }
  )

  ipcMain.handle(
    AI_IPC.simplifySuggestion,
    async (_event, args: { requestId: string; text: string }): Promise<IpcResult<string>> => {
      try {
        const data = await simplifySuggestionText(args.requestId, args.text)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toSerializableError(err) }
      }
    }
  )
}
