import { ipcMain, type WebContents } from 'electron'
import { LOCAL_AI_IPC, DEFAULT_SCENE_PLAN_OPTIONS } from '@shared/localAi'
import type { GenerateScenePlanResult, LocalAiError, ModelPullProgress, ScenePlanGenerationOptions } from '@shared/localAi'
import type { TranscriptSegment } from '@shared/transcription'
import {
  getHealth,
  listModels,
  pullModel,
  unloadModel,
  generateScenePlan,
  cancelRequest,
  LocalAiProviderError
} from '../ai/localAiService'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: LocalAiError }

// Same reasoning as app/main/ipc/ai.ts's identical helper: thrown errors
// lose their subclass fields crossing IPC, so every operation below catches
// internally and returns a discriminated result instead of throwing.
function toSerializableError(err: unknown): LocalAiError {
  if (err instanceof LocalAiProviderError) return { kind: err.kind, message: err.message }
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) }
}

function runPull(sender: WebContents, requestId: string, model: string): void {
  void pullModel(requestId, model, (progress: ModelPullProgress) => {
    if (!sender.isDestroyed()) sender.send(LOCAL_AI_IPC.pullProgress, progress)
  }).catch((err) => {
    if (sender.isDestroyed()) return
    const error = toSerializableError(err)
    sender.send(LOCAL_AI_IPC.pullProgress, {
      requestId,
      model,
      percent: 0,
      status: error.kind === 'canceled' ? 'canceled' : 'error',
      message: error.message
    } satisfies ModelPullProgress)
  })
}

export function registerLocalAiIpc(): void {
  ipcMain.handle(LOCAL_AI_IPC.getHealth, async () => getHealth())

  ipcMain.handle(LOCAL_AI_IPC.listModels, async (): Promise<IpcResult<Awaited<ReturnType<typeof listModels>>>> => {
    try {
      return { ok: true, data: await listModels() }
    } catch (err) {
      return { ok: false, error: toSerializableError(err) }
    }
  })

  // Fire-and-forget, like MEDIA_IPC.importPaths -- a multi-GB download can
  // run for many minutes, far longer than a sensible request/response
  // lifetime. Progress (including the terminal success/error/canceled
  // state) streams back over LOCAL_AI_IPC.pullProgress instead.
  ipcMain.handle(LOCAL_AI_IPC.pullModel, async (event, args: { requestId: string; model: string }) => {
    runPull(event.sender, args.requestId, args.model)
  })

  ipcMain.handle(LOCAL_AI_IPC.retryPull, async (event, args: { requestId: string; model: string }) => {
    runPull(event.sender, args.requestId, args.model)
  })

  ipcMain.handle(LOCAL_AI_IPC.cancelPull, async (_event, requestId: string) => cancelRequest(requestId))

  ipcMain.handle(LOCAL_AI_IPC.unloadModel, async (_event, model: string) => {
    await unloadModel(model)
  })

  ipcMain.handle(
    LOCAL_AI_IPC.generateScenePlan,
    async (
      _event,
      args: {
        requestId: string
        mediaId: string
        segments: TranscriptSegment[]
        mediaDurationSeconds: number
        model: string
        options?: ScenePlanGenerationOptions
      }
    ): Promise<IpcResult<GenerateScenePlanResult>> => {
      try {
        const data = await generateScenePlan(
          args.requestId,
          args.mediaId,
          args.segments,
          args.mediaDurationSeconds,
          args.model,
          args.options ?? DEFAULT_SCENE_PLAN_OPTIONS
        )
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toSerializableError(err) }
      }
    }
  )

  ipcMain.handle(LOCAL_AI_IPC.cancelGenerate, async (_event, requestId: string) => cancelRequest(requestId))
}
