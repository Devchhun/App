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
import { resolveSegmentMove, resolveSegmentSetMove } from './segmentMove'

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
  /** Spoken language hint for Whisper -- lives here (with the model
   * choice) so Settings › Transcription and the Transcript panel agree;
   * both persist per machine. */
  language: TranscriptionLanguage
  setLanguage: (language: TranscriptionLanguage) => void
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
  /** Removes one or more Timeline caption blocks in one atomic update. */
  removeSegments: (mediaId: string, segmentIds: string[]) => void
  /** Slides one subtitle to a new start time, keeping its length -- the
   * Timeline's caption row drags call this. Re-sorts so the segment list
   * stays in time order (every consumer, the AI Dubber row list included,
   * walks it as chronological). */
  /** Moves a caption to `newStartTime`, or to the nearest free spot when
   * that would overlap a neighbour (see segmentMove.ts). Returns where it
   * actually landed, or null when it stayed put. */
  moveSegment: (mediaId: string, segmentId: string, newStartTime: number) => number | null
  /** Moves every selected caption by one shared delta and returns that
   * applied delta. Linked voice clips use it to follow the whole group. */
  moveSegments: (mediaId: string, segmentIds: string[], draggedSegmentId: string, newStartTime: number) => number | null
  /** Story Narration Workspace's SRT import -- merges a synthetic
   * `Transcript` (parsed via shared/srt.ts, `source: 'srt'`) into this same
   * `transcripts` record. Deliberately the SAME state the AI-transcription
   * pipeline writes to, so every existing consumer (Timeline.tsx's C1
   * caption row, VoiceoverRecorder.tsx's segment stepping) picks it up with
   * no changes of their own -- as long as this mediaId is also the
   * currently-selected media (see NarrationContext.prepareWorkspace). */
  setImportedTranscript: (mediaId: string, transcript: Transcript) => void
  /** Drops a media's transcript entirely -- its captions leave the Timeline
   * (AI Dubber's Remove SRT). */
  removeTranscript: (mediaId: string) => void

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
const MODEL_STORAGE_KEY = 'cae-transcription-model-v1'
const LANGUAGE_STORAGE_KEY = 'cae-transcription-language-v1'
const MODEL_IDS: WhisperModelSize[] = ['tiny', 'base', 'small', 'medium', 'large-v3']
const LANGUAGES: TranscriptionLanguage[] = ['auto', 'km', 'en']

function readStored<T extends string>(key: string, allowed: T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return allowed.includes(raw as T) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable/full -- the in-memory choice still applies this session.
  }
}

export function TranscriptProvider({ children }: { children: ReactNode }): JSX.Element {
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [selectedModelId, setSelectedModelIdState] = useState<WhisperModelSize>(() => readStored(MODEL_STORAGE_KEY, MODEL_IDS, DEFAULT_MODEL))
  const [language, setLanguageState] = useState<TranscriptionLanguage>(() => readStored(LANGUAGE_STORAGE_KEY, LANGUAGES, 'auto'))
  const setSelectedModelId = useCallback((id: WhisperModelSize) => {
    setSelectedModelIdState(id)
    persist(MODEL_STORAGE_KEY, id)
  }, [])
  const setLanguage = useCallback((next: TranscriptionLanguage) => {
    setLanguageState(next)
    persist(LANGUAGE_STORAGE_KEY, next)
  }, [])
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

  const removeSegments = useCallback((mediaId: string, segmentIds: string[]) => {
    if (segmentIds.length === 0) return
    const ids = new Set(segmentIds)
    setTranscripts((prev) => {
      const transcript = prev[mediaId]
      if (!transcript) return prev
      return {
        ...prev,
        [mediaId]: { ...transcript, segments: transcript.segments.filter((segment) => !ids.has(segment.id)) }
      }
    })
  }, [])

  const moveSegment = useCallback(
    (mediaId: string, segmentId: string, newStartTime: number): number | null => {
      const transcript = transcripts[mediaId]
      const seg = transcript?.segments.find((s) => s.id === segmentId)
      if (!transcript || !seg) return null
      // Captions never overlap each other: the drop lands where asked,
      // or is nudged to the nearest free spot, or is refused.
      const start = resolveSegmentMove(transcript.segments, segmentId, newStartTime)
      if (start === null) return null
      const delta = start - seg.startTime
      if (delta === 0) return start
      const moved = {
        ...seg,
        startTime: start,
        endTime: seg.endTime + delta,
        words: seg.words.map((w) => ({ ...w, startTime: w.startTime + delta, endTime: w.endTime + delta }))
      }
      const segments = transcript.segments.map((s) => (s.id === segmentId ? moved : s)).sort((a, b) => a.startTime - b.startTime)
      setTranscripts((prev) => (prev[mediaId] ? { ...prev, [mediaId]: { ...prev[mediaId], segments } } : prev))
      return start
    },
    [transcripts]
  )

  const moveSegments = useCallback(
    (mediaId: string, segmentIds: string[], draggedSegmentId: string, newStartTime: number): number | null => {
      const transcript = transcripts[mediaId]
      if (!transcript || segmentIds.length === 0) return null
      const delta = resolveSegmentSetMove(transcript.segments, segmentIds, draggedSegmentId, newStartTime)
      if (delta === null || delta === 0) return delta
      const ids = new Set(segmentIds)
      const shifted = transcript.segments
        .map((segment) =>
          ids.has(segment.id)
            ? {
                ...segment,
                startTime: segment.startTime + delta,
                endTime: segment.endTime + delta,
                words: segment.words.map((word) => ({
                  ...word,
                  startTime: word.startTime + delta,
                  endTime: word.endTime + delta
                }))
              }
            : segment
        )
        .sort((a, b) => a.startTime - b.startTime)
      setTranscripts((prev) => (prev[mediaId] ? { ...prev, [mediaId]: { ...prev[mediaId], segments: shifted } } : prev))
      return delta
    },
    [transcripts]
  )

  const setImportedTranscript = useCallback((mediaId: string, transcript: Transcript) => {
    setTranscripts((prev) => ({ ...prev, [mediaId]: transcript }))
  }, [])

  const removeTranscript = useCallback((mediaId: string) => {
    setTranscripts((prev) => {
      if (!(mediaId in prev)) return prev
      const { [mediaId]: _removed, ...rest } = prev
      return rest
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
      language,
      setLanguage,
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
      removeSegments,
      moveSegment,
      moveSegments,
      setImportedTranscript,
      removeTranscript,
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
      setSelectedModelId,
      language,
      setLanguage,
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
      removeSegments,
      moveSegment,
      moveSegments,
      setImportedTranscript,
      removeTranscript,
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
