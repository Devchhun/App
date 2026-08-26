import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  DeviceInfo,
  GpuVerificationResult,
  ModelStatus,
  ModelDownloadProgress,
  Transcript,
  TranscriptionProgressUpdate,
  TranscriptionLanguage,
  WhisperModelSize,
  ScriptAlignment,
  ScriptAlignmentSegment,
  CorrectionDictionaryEntry,
  CorrectionCategory
} from '@shared/transcription'

interface ProvisionProgress {
  stage: 'checking-python' | 'creating-venv' | 'installing-dependencies' | 'ready' | 'error'
  message?: string
  percent: number
}

interface TranscriptStatus {
  stage: TranscriptionProgressUpdate['stage']
  percent: number
  errorMessage?: string
}

interface TranscriptContextValue {
  deviceInfo: DeviceInfo | null
  retryGpuDetection: () => Promise<void>
  verifyGpu: () => Promise<GpuVerificationResult>
  models: ModelStatus[]
  selectedModelId: WhisperModelSize
  setSelectedModelId: (id: WhisperModelSize) => void
  modelDownloadProgress: ModelDownloadProgress | null
  workerStatus: ProvisionProgress | null
  refreshModels: () => Promise<void>
  downloadModel: (modelId: WhisperModelSize) => Promise<void>
  cancelModelDownload: () => void

  transcripts: Record<string, Transcript>
  transcriptStatus: Record<string, TranscriptStatus>
  startTranscription: (mediaId: string, originalPath: string, language: TranscriptionLanguage) => void
  pauseTranscription: () => void
  resumeTranscription: () => void
  cancelTranscription: () => void
  retryTranscription: (mediaId: string) => void
  updateSegmentText: (mediaId: string, segmentId: string, newText: string) => void

  scriptAlignments: Record<string, ScriptAlignmentSegment[]>
  scriptTexts: Record<string, string>
  alignScript: (mediaId: string, scriptText: string) => Promise<void>
  hydrateFromSaved: (
    transcripts: Record<string, Transcript>,
    scriptAlignments: Record<string, ScriptAlignment>
  ) => void

  correctionDictionary: CorrectionDictionaryEntry[]
  addCorrectionEntry: (
    original: string,
    correction: string,
    category: CorrectionCategory,
    language: 'km' | 'en' | 'mixed'
  ) => Promise<void>
  removeCorrectionEntry: (id: string) => Promise<void>
}

const TranscriptContext = createContext<TranscriptContextValue | null>(null)

const DEFAULT_MODEL: WhisperModelSize = 'small'

export function TranscriptProvider({ children }: { children: ReactNode }): JSX.Element {
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [selectedModelId, setSelectedModelId] = useState<WhisperModelSize>(DEFAULT_MODEL)
  const [modelDownloadProgress, setModelDownloadProgress] = useState<ModelDownloadProgress | null>(null)
  const [workerStatus, setWorkerStatus] = useState<ProvisionProgress | null>(null)

  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({})
  const [transcriptStatus, setTranscriptStatus] = useState<Record<string, TranscriptStatus>>({})
  const [scriptAlignments, setScriptAlignments] = useState<Record<string, ScriptAlignmentSegment[]>>({})
  const [scriptTexts, setScriptTexts] = useState<Record<string, string>>({})
  const [correctionDictionary, setCorrectionDictionary] = useState<CorrectionDictionaryEntry[]>([])

  const refreshModels = useCallback(async () => {
    const statuses = await window.api.transcription.listModels()
    setModels(statuses)
  }, [])

  const retryGpuDetection = useCallback(async () => {
    const info = await window.api.transcription.retryGpuDetection()
    setDeviceInfo(info)
  }, [])

  const verifyGpu = useCallback(async () => {
    const result = await window.api.transcription.verifyGpu()
    if (result.ok) {
      const info = await window.api.transcription.getDeviceInfo()
      setDeviceInfo(info)
    }
    return result
  }, [])

  useEffect(() => {
    window.api.transcription.getDeviceInfo().then(setDeviceInfo)
    void refreshModels()
    window.api.transcription.getCorrectionDictionary().then(setCorrectionDictionary)

    const unsubProgress = window.api.transcription.onProgress((update) => {
      setTranscriptStatus((prev) => ({
        ...prev,
        [update.mediaId]: { stage: update.stage, percent: update.percent, errorMessage: update.errorMessage }
      }))
      if (update.transcript) {
        setTranscripts((prev) => ({ ...prev, [update.mediaId]: update.transcript as Transcript }))
      }
    })
    const unsubDownload = window.api.transcription.onModelDownloadProgress((p) => {
      setModelDownloadProgress(p)
      if (p.stage === 'ready' || p.stage === 'canceled' || p.stage === 'error') {
        void refreshModels()
      }
    })
    const unsubWorkerStatus = window.api.transcription.onWorkerStatus(setWorkerStatus)

    return () => {
      unsubProgress()
      unsubDownload()
      unsubWorkerStatus()
    }
  }, [refreshModels])

  const downloadModel = useCallback(async (modelId: WhisperModelSize) => {
    setModelDownloadProgress({ modelId, stage: 'downloading', percent: 0 })
    await window.api.transcription.downloadModel(modelId)
  }, [])

  const cancelModelDownload = useCallback(() => {
    void window.api.transcription.cancelModelDownload()
  }, [])

  const startTranscription = useCallback(
    (mediaId: string, originalPath: string, language: TranscriptionLanguage) => {
      setTranscriptStatus((prev) => ({ ...prev, [mediaId]: { stage: 'queued', percent: 0 } }))
      void window.api.transcription.start({ mediaId, originalPath, modelId: selectedModelId, language })
    },
    [selectedModelId]
  )

  const pauseTranscription = useCallback(() => void window.api.transcription.pause(), [])
  const resumeTranscription = useCallback(() => void window.api.transcription.resume(), [])
  const cancelTranscription = useCallback(() => void window.api.transcription.cancel(), [])
  const retryTranscription = useCallback((mediaId: string) => void window.api.transcription.retry(mediaId), [])

  const updateSegmentText = useCallback((mediaId: string, segmentId: string, newText: string) => {
    setTranscripts((prev) => {
      const transcript = prev[mediaId]
      if (!transcript) return prev
      return {
        ...prev,
        [mediaId]: {
          ...transcript,
          segments: transcript.segments.map((seg) => (seg.id === segmentId ? { ...seg, editedText: newText } : seg))
        }
      }
    })
  }, [])

  const alignScript = useCallback(
    async (mediaId: string, scriptText: string) => {
      const transcript = transcripts[mediaId]
      if (!transcript) return
      const words = transcript.segments.flatMap((seg) => seg.words)
      const result = await window.api.transcription.alignScript(scriptText, words)
      setScriptAlignments((prev) => ({ ...prev, [mediaId]: result }))
      setScriptTexts((prev) => ({ ...prev, [mediaId]: scriptText }))
    },
    [transcripts]
  )

  const hydrateFromSaved = useCallback(
    (savedTranscripts: Record<string, Transcript>, savedScriptAlignments: Record<string, ScriptAlignment>) => {
      setTranscripts(savedTranscripts)
      setScriptAlignments(
        Object.fromEntries(Object.entries(savedScriptAlignments).map(([mediaId, a]) => [mediaId, a.segments]))
      )
      setScriptTexts(
        Object.fromEntries(Object.entries(savedScriptAlignments).map(([mediaId, a]) => [mediaId, a.scriptText]))
      )
    },
    []
  )

  const addCorrectionEntry = useCallback(
    async (original: string, correction: string, category: CorrectionCategory, language: 'km' | 'en' | 'mixed') => {
      const entry = await window.api.transcription.addCorrectionEntry(original, correction, category, language)
      setCorrectionDictionary((prev) => {
        const existingIndex = prev.findIndex((e) => e.id === entry.id)
        if (existingIndex >= 0) {
          const next = [...prev]
          next[existingIndex] = entry
          return next
        }
        return [...prev, entry]
      })
    },
    []
  )

  const removeCorrectionEntry = useCallback(async (id: string) => {
    await window.api.transcription.removeCorrectionEntry(id)
    setCorrectionDictionary((prev) => prev.filter((e) => e.id !== id))
  }, [])

  const value = useMemo<TranscriptContextValue>(
    () => ({
      deviceInfo,
      retryGpuDetection,
      verifyGpu,
      models,
      selectedModelId,
      setSelectedModelId,
      modelDownloadProgress,
      workerStatus,
      refreshModels,
      downloadModel,
      cancelModelDownload,
      transcripts,
      transcriptStatus,
      startTranscription,
      pauseTranscription,
      resumeTranscription,
      cancelTranscription,
      retryTranscription,
      updateSegmentText,
      scriptAlignments,
      scriptTexts,
      alignScript,
      hydrateFromSaved,
      correctionDictionary,
      addCorrectionEntry,
      removeCorrectionEntry
    }),
    [
      deviceInfo,
      retryGpuDetection,
      verifyGpu,
      models,
      selectedModelId,
      modelDownloadProgress,
      workerStatus,
      refreshModels,
      downloadModel,
      cancelModelDownload,
      transcripts,
      transcriptStatus,
      startTranscription,
      pauseTranscription,
      resumeTranscription,
      cancelTranscription,
      retryTranscription,
      updateSegmentText,
      scriptAlignments,
      scriptTexts,
      alignScript,
      hydrateFromSaved,
      correctionDictionary,
      addCorrectionEntry,
      removeCorrectionEntry
    ]
  )

  return <TranscriptContext.Provider value={value}>{children}</TranscriptContext.Provider>
}

export function useTranscript(): TranscriptContextValue {
  const ctx = useContext(TranscriptContext)
  if (!ctx) throw new Error('useTranscript must be used within TranscriptProvider')
  return ctx
}
