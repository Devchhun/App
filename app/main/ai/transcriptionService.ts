import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'
import { cacheKeyForFile, ensureCacheDir, pathExists } from '../media/cache'
import { extractTranscriptionAudio } from '../media/audioExtract'
import { getSharedWorker, WorkerCanceledError } from './workerProcess'
import { getModelDownloadRoot } from './modelManager'
import type { Transcript, TranscriptionLanguage, TranscriptionProgressUpdate, WhisperModelSize } from '@shared/transcription'

interface QueueItem {
  mediaId: string
  originalPath: string
  modelId: WhisperModelSize
  language: TranscriptionLanguage
  onProgress: (u: TranscriptionProgressUpdate) => void
  resolve: (t: Transcript) => void
  reject: (err: Error) => void
}

// The worker handles one job at a time (loading a Whisper model is memory-heavy);
// concurrent transcription requests are queued and processed FIFO.
const queue: QueueItem[] = []
let processing = false

function transcriptCachePath(cacheDir: string, modelId: string, language: string): string {
  return join(cacheDir, `transcript.${modelId}.${language}.json`)
}

export function startTranscription(
  mediaId: string,
  originalPath: string,
  modelId: WhisperModelSize,
  language: TranscriptionLanguage,
  onProgress: (u: TranscriptionProgressUpdate) => void
): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    onProgress({ mediaId, stage: 'queued', percent: 0 })
    queue.push({ mediaId, originalPath, modelId, language, onProgress, resolve, reject })
    void processQueue()
  })
}

async function processQueue(): Promise<void> {
  if (processing) return
  const item = queue.shift()
  if (!item) return
  processing = true
  try {
    await runOne(item)
  } finally {
    processing = false
    void processQueue()
  }
}

async function runOne(item: QueueItem): Promise<void> {
  const { mediaId, originalPath, modelId, language, onProgress, resolve, reject } = item
  try {
    const cacheKey = await cacheKeyForFile(originalPath)
    const cacheDir = await ensureCacheDir(cacheKey)
    const cachePath = transcriptCachePath(cacheDir, modelId, language)

    if (await pathExists(cachePath)) {
      const transcript = JSON.parse(await readFile(cachePath, 'utf-8')) as Transcript
      onProgress({ mediaId, stage: 'ready', percent: 100, transcript })
      resolve(transcript)
      return
    }

    onProgress({ mediaId, stage: 'preparing-audio', percent: 0 })
    const audio = await extractTranscriptionAudio(mediaId, originalPath, cacheDir)

    const worker = getSharedWorker()
    await worker.ensureStarted()

    const { promise } = worker.send(
      'transcribe',
      { mediaId, audioPath: audio.outputPath, modelId, language, downloadRoot: getModelDownloadRoot() },
      (data) => onProgress(data as TranscriptionProgressUpdate)
    )
    const result = (await promise) as { transcript: Transcript }
    const transcript = result.transcript

    const tmpPath = `${cachePath}.tmp`
    await writeFile(tmpPath, JSON.stringify(transcript))
    await rename(tmpPath, cachePath)

    onProgress({ mediaId, stage: 'ready', percent: 100, transcript })
    resolve(transcript)
  } catch (err) {
    if (err instanceof WorkerCanceledError) {
      onProgress({ mediaId, stage: 'canceled', percent: 0 })
      reject(err)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      onProgress({ mediaId, stage: 'error', percent: 0, errorMessage: message })
      reject(err instanceof Error ? err : new Error(message))
    }
  }
}

export function pauseTranscription(): void {
  getSharedWorker().sendControl('pause')
}

export function resumeTranscription(): void {
  getSharedWorker().sendControl('resume')
}

export function cancelTranscription(): void {
  getSharedWorker().sendControl('cancel')
}
