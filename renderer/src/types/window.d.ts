import type { FfmpegAvailability, MediaItem, MediaProgressUpdate } from '@shared/media'
import type {
  DeviceInfo,
  GpuVerificationResult,
  ModelStatus,
  ModelDownloadProgress,
  TranscriptionProgressUpdate,
  TranscriptionLanguage,
  WhisperModelSize,
  ScriptAlignmentSegment,
  TranscriptWord,
  TranscriptSegment,
  CorrectionDictionaryEntry,
  CorrectionCategory
} from '@shared/transcription'
import type { ProjectFile, MediaSource, ProjectSequence } from '@shared/project'
import type { AiSuggestion, CloudRequestPreview, GenerateSuggestionsResult, GenerateSuggestionsError } from '@shared/suggestions'
import type { LocalAiHealth, LocalModelInfo, ModelPullProgress, GenerateScenePlanResult, LocalAiError, ScenePlanGenerationOptions } from '@shared/localAi'
import type { GenerateNarrativeGraphResult, StoryAnalysisError } from '@shared/story'
import type { ExportOptions, ExportProgress, ExportCapabilities } from '@shared/export'
import type { UpdaterStatus } from '@shared/updater'

export {}

interface StartTranscriptionParams {
  mediaId: string
  originalPath: string
  modelId: WhisperModelSize
  language: TranscriptionLanguage
}

interface CorrectionEntryUpdates {
  original?: string
  correction?: string
  category?: CorrectionCategory
  language?: 'km' | 'en' | 'mixed'
  enabled?: boolean
}

interface ProvisionProgress {
  stage: 'checking-python' | 'creating-venv' | 'installing-dependencies' | 'ready' | 'error'
  message?: string
  percent: number
}

declare global {
  interface Window {
    api: {
      getAppVersion: () => Promise<string>
      media: {
        pickFiles: () => Promise<string[]>
        importPaths: (paths: string[]) => Promise<void>
        cancelJob: (mediaId: string) => Promise<boolean>
        retryJob: (mediaId: string) => Promise<void>
        getFfmpegStatus: () => Promise<FfmpegAvailability>
        rehydrate: (sources: MediaSource[]) => Promise<MediaItem[]>
        saveGeneratedFile: (fileName: string, data: Uint8Array) => Promise<string>
        onProgress: (callback: (update: MediaProgressUpdate) => void) => () => void
        getPathForFile: (file: File) => string
      }
      transcription: {
        getDeviceInfo: () => Promise<DeviceInfo>
        retryGpuDetection: () => Promise<DeviceInfo>
        verifyGpu: () => Promise<GpuVerificationResult>
        listModels: () => Promise<ModelStatus[]>
        downloadModel: (modelId: WhisperModelSize) => Promise<void>
        cancelModelDownload: () => Promise<void>
        onModelDownloadProgress: (callback: (p: ModelDownloadProgress) => void) => () => void
        start: (params: StartTranscriptionParams) => Promise<void>
        pause: () => Promise<void>
        resume: () => Promise<void>
        cancel: () => Promise<void>
        retry: (mediaId: string) => Promise<void>
        onProgress: (callback: (update: TranscriptionProgressUpdate) => void) => () => void
        alignScript: (scriptText: string, words: TranscriptWord[]) => Promise<ScriptAlignmentSegment[]>
        getCorrectionDictionary: () => Promise<CorrectionDictionaryEntry[]>
        addCorrectionEntry: (
          original: string,
          correction: string,
          category: CorrectionCategory,
          language: 'km' | 'en' | 'mixed'
        ) => Promise<CorrectionDictionaryEntry>
        updateCorrectionEntry: (id: string, updates: CorrectionEntryUpdates) => Promise<CorrectionDictionaryEntry | null>
        removeCorrectionEntry: (id: string) => Promise<void>
        exportCorrectionDictionaryToFile: () => Promise<{ canceled: boolean; filePath?: string }>
        importCorrectionDictionaryFromFile: (
          mode: 'merge' | 'replace'
        ) => Promise<{ canceled: boolean; entries?: CorrectionDictionaryEntry[] }>
        onWorkerStatus: (callback: (p: ProvisionProgress) => void) => () => void
      }
      project: {
        getOrCreateStartup: () => Promise<ProjectFile>
        save: (project: ProjectFile) => Promise<string>
      }
      ai: {
        hasApiKey: () => Promise<boolean>
        setApiKey: (key: string) => Promise<void>
        clearApiKey: () => Promise<void>
        previewCloudRequest: (segments: TranscriptSegment[]) => Promise<CloudRequestPreview>
        generateSuggestions: (
          requestId: string,
          mediaId: string,
          segments: TranscriptSegment[],
          forceRegenerate: boolean
        ) => Promise<{ ok: true; data: GenerateSuggestionsResult } | { ok: false; error: GenerateSuggestionsError }>
        cancelRequest: (requestId: string) => Promise<boolean>
        regenerateSuggestion: (
          requestId: string,
          mediaId: string,
          segment: TranscriptSegment
        ) => Promise<{ ok: true; data: AiSuggestion | null } | { ok: false; error: GenerateSuggestionsError }>
        simplifySuggestion: (
          requestId: string,
          text: string
        ) => Promise<{ ok: true; data: string } | { ok: false; error: GenerateSuggestionsError }>
      }
      localAi: {
        getHealth: () => Promise<LocalAiHealth>
        listModels: () => Promise<{ ok: true; data: LocalModelInfo[] } | { ok: false; error: LocalAiError }>
        pullModel: (requestId: string, model: string) => Promise<void>
        retryPull: (requestId: string, model: string) => Promise<void>
        cancelPull: (requestId: string) => Promise<boolean>
        unloadModel: (model: string) => Promise<void>
        onPullProgress: (callback: (p: ModelPullProgress) => void) => () => void
        generateScenePlan: (
          requestId: string,
          mediaId: string,
          segments: TranscriptSegment[],
          mediaDurationSeconds: number,
          model: string,
          options?: ScenePlanGenerationOptions
        ) => Promise<{ ok: true; data: GenerateScenePlanResult } | { ok: false; error: LocalAiError }>
        cancelGenerate: (requestId: string) => Promise<boolean>
      }
      story: {
        previewAnalysis: (segments: TranscriptSegment[]) => Promise<CloudRequestPreview>
        analyzeStory: (
          requestId: string,
          mediaId: string,
          segments: TranscriptSegment[],
          mediaDurationSeconds: number,
          creativity: number
        ) => Promise<{ ok: true; data: GenerateNarrativeGraphResult } | { ok: false; error: StoryAnalysisError }>
        cancelAnalysis: (requestId: string) => Promise<boolean>
      }
      export: {
        pickOutputDir: () => Promise<{ canceled: boolean; path?: string }>
        getCapabilities: () => Promise<ExportCapabilities>
        startExport: (
          requestId: string,
          sequence: ProjectSequence,
          mediaById: Record<string, { originalPath: string }>,
          aspectRatio: '16:9' | '9:16' | '1:1',
          options: ExportOptions
        ) => Promise<void>
        cancelExport: (requestId: string) => Promise<boolean>
        onProgress: (callback: (p: ExportProgress) => void) => () => void
      }
      windowControls: {
        minimize: () => Promise<void>
        maximizeToggle: () => Promise<void>
        close: () => Promise<void>
        isMaximized: () => Promise<boolean>
        onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void
      }
      updater: {
        check: () => Promise<void>
        quitAndInstall: () => Promise<void>
        onStatus: (callback: (status: UpdaterStatus) => void) => () => void
      }
    }
  }
}
