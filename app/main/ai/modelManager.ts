import { app } from 'electron'
import { join } from 'path'
import { getSharedWorker, WorkerCanceledError } from './workerProcess'
import type { ModelStatus, ModelDownloadProgress, WhisperModelSize } from '@shared/transcription'

export function getModelDownloadRoot(): string {
  return join(app.getPath('userData'), 'whisper-models')
}

export async function listModelStatuses(): Promise<ModelStatus[]> {
  const worker = getSharedWorker()
  await worker.ensureStarted()
  const { promise } = worker.send('list_models', { downloadRoot: getModelDownloadRoot() })
  return (await promise) as ModelStatus[]
}

export async function downloadModel(
  modelId: WhisperModelSize,
  onProgress: (p: ModelDownloadProgress) => void
): Promise<void> {
  const worker = getSharedWorker()
  await worker.ensureStarted()
  const { promise } = worker.send(
    'download_model',
    { modelId, downloadRoot: getModelDownloadRoot() },
    (data) => onProgress(data as ModelDownloadProgress)
  )
  try {
    await promise
    onProgress({ modelId, stage: 'ready', percent: 100 })
  } catch (err) {
    if (err instanceof WorkerCanceledError) {
      onProgress({ modelId, stage: 'canceled', percent: 0 })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      onProgress({ modelId, stage: 'error', percent: 0, errorMessage: message })
      throw err
    }
  }
}

export function cancelModelDownload(): void {
  getSharedWorker().sendControl('cancel')
}
