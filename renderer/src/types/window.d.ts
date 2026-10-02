// The renderer's view of the preload bridge (app/preload/index.ts).
// Mirrors that file's `api` object exactly -- when the preload gains a
// method, add it here too so the renderer can call it.
import type { FfmpegAvailability, MediaItem, MediaProgressUpdate, WaveformData } from '@shared/media'
import type { DeviceInfo, GpuVerificationResult, ModelStatus, ModelDownloadProgress, TranscriptionProgressUpdate, TranscriptionLanguage, WhisperModelSize, ScriptAlignmentSegment, TranscriptWord, TranscriptSegment, CorrectionDictionaryEntry, CorrectionCategory, DetectSpeakersRequest, DetectSpeakersResult, DetectSpeakersProgress } from '@shared/transcription'
import type { ProjectFile, MediaSource, ProjectSequence, ProjectSummary } from '@shared/project'
import type { AiSuggestion, CloudRequestPreview, GenerateSuggestionsResult, GenerateSuggestionsError, ScriptTransformMode } from '@shared/suggestions'
import type { LocalAiHealth, LocalModelInfo, ModelPullProgress, GenerateScenePlanResult, LocalAiError, ScenePlanGenerationOptions } from '@shared/localAi'
import type { GenerateNarrativeGraphResult, StoryAnalysisError } from '@shared/story'
import type { ExportOptions, ExportProgress, ExportCapabilities } from '@shared/export'
import type { UpdaterStatus } from '@shared/updater'
import type { LicenseStatus, ActivateLicenseResult } from '@shared/license'
import type { AnimationIpcResult, AnimationProgress, AnimationRequest } from '@shared/aiAnimation'
import type { CrashReport } from '@shared/crash'
import type { DetectSpeakerResult, NarrationOptimizationSettings } from '@shared/narration'
import type { RefitClipAudioResult, PrepareReferenceClipResult, VoxCpmDevice } from '@shared/dubbing'
import type { ValidateVoxCpmInstallResult, DubbingGenerationRequest, DubbingGenerationProgressEvent, AnalyzePerformanceLine, AnalyzePerformanceResult } from '@shared/dubbing'
import type { RemoveVocalsResult, VocalRemovalProgress } from '@shared/vocalRemoval'
import type { TranslateSubtitlesResult, TranslationError } from '@shared/translation'
import type { RegenerateNarrationSceneRequest, StoryLibrary, StoryOutlineIpcResult, StoryOutlineRequest, StoryScriptRequest, VideoStoryNarrationIpcResult, VideoStoryNarrationProgress, VideoStoryNarrationRequest, VideoStoryNarrationScene } from '@shared/videoStoryNarration'
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
type IpcResult<T> = {
  ok: true
  data: T
} | {
  ok: false
  error: GenerateSuggestionsError
}
type TranslationIpcResult<T> = {
  ok: true
  data: T
} | {
  ok: false
  error: TranslationError
}
type LocalAiIpcResult<T> = {
  ok: true
  data: T
} | {
  ok: false
  error: LocalAiError
}
type StoryIpcResult<T> = {
  ok: true
  data: T
} | {
  ok: false
  error: StoryAnalysisError
}
interface ProvisionProgress {
  stage: 'checking-python' | 'creating-venv' | 'installing-dependencies' | 'ready' | 'error'
  message?: string
  percent: number
}

export {}

declare global {
  interface Window {
    api: {
      getAppVersion: () => Promise<string>
      media: {
        pickFiles: () => Promise<string[]>
        /** A URL for an imported still image's own file (see MEDIA_IPC.imageUrl). */
        imageUrl: (filePath: string) => Promise<string | null>
        /** Remove Background on a still image (see MEDIA_IPC.removeBackground). */
        removeBackground: (jobId: string, imagePath: string) => Promise<import('@shared/media').RemoveBackgroundResult>
        cancelRemoveBackground: (jobId: string) => Promise<boolean>
        onRemoveBackgroundProgress: (callback: (progress: import('@shared/media').RemoveBackgroundProgress) => void) => () => void
        importPaths: (paths: string[]) => Promise<void>
        cancelJob: (mediaId: string) => Promise<boolean>
        retryJob: (mediaId: string) => Promise<void>
        getFfmpegStatus: () => Promise<FfmpegAvailability>
        rehydrate: (sources: MediaSource[]) => Promise<MediaItem[]>
        saveGeneratedFile: (fileName: string, data: Uint8Array) => Promise<string>
        saveStillFrame: (dirPath: string, fileName: string, data: Uint8Array) => Promise<string>
        getDefaultStillDir: () => Promise<string>
        ensureWaveform: (mediaId: string, originalPath: string) => Promise<WaveformData | null>
        onProgress: (callback: (update: MediaProgressUpdate) => void) => (() => void)
        getPathForFile: (file: File) => string
      }
      transcription: {
        getDeviceInfo: () => Promise<DeviceInfo>
        retryGpuDetection: () => Promise<DeviceInfo>
        verifyGpu: () => Promise<GpuVerificationResult>
        listModels: () => Promise<ModelStatus[]>
        downloadModel: (modelId: WhisperModelSize) => Promise<void>
        cancelModelDownload: () => Promise<void>
        onModelDownloadProgress: (callback: (p: ModelDownloadProgress) => void) => (() => void)
        start: (params: StartTranscriptionParams) => Promise<void>
        pause: () => Promise<void>
        resume: () => Promise<void>
        cancel: () => Promise<void>
        retry: (mediaId: string) => Promise<void>
        onProgress: (callback: (update: TranscriptionProgressUpdate) => void) => (() => void)
        alignScript: (scriptText: string, words: TranscriptWord[]) => Promise<ScriptAlignmentSegment[]>
        getCorrectionDictionary: () => Promise<CorrectionDictionaryEntry[]>
        addCorrectionEntry: (original: string, correction: string, category: CorrectionCategory, language: "km" | "en" | "mixed") => Promise<CorrectionDictionaryEntry>
        updateCorrectionEntry: (id: string, updates: CorrectionEntryUpdates) => Promise<CorrectionDictionaryEntry | null>
        removeCorrectionEntry: (id: string) => Promise<void>
        exportCorrectionDictionaryToFile: () => Promise<{
          canceled: boolean
          filePath?: string
        }>
        importCorrectionDictionaryFromFile: (mode: "merge" | "replace") => Promise<{
          canceled: boolean
          entries?: CorrectionDictionaryEntry[]
        }>
        importSrtFile: (options?: { multiple?: boolean }) => Promise<{
          canceled: boolean
          fileName?: string
          srtText?: string
          files?: { fileName: string; srtText: string }[]
        }>
        detectSpeakers: (request: DetectSpeakersRequest) => Promise<DetectSpeakersResult>
        cancelDetectSpeakers: (jobId: string) => Promise<boolean>
        onDetectSpeakersProgress: (callback: (progress: DetectSpeakersProgress) => void) => (() => void)
        onWorkerStatus: (callback: (p: ProvisionProgress) => void) => (() => void)
      }
      project: {
        getOrCreateStartup: () => Promise<ProjectFile>
        save: (project: ProjectFile) => Promise<string>
        list: () => Promise<ProjectSummary[]>
        listTrash: () => Promise<ProjectSummary[]>
        create: (name: string) => Promise<ProjectSummary>
        open: (id: string) => Promise<void>
        rename: (id: string, name: string) => Promise<void>
        trash: (id: string) => Promise<void>
        restore: (id: string) => Promise<void>
        deleteForever: (id: string) => Promise<void>
      }
      ai: {
        hasApiKey: () => Promise<boolean>
        setApiKey: (key: string) => Promise<void>
        clearApiKey: () => Promise<void>
        previewCloudRequest: (segments: TranscriptSegment[]) => Promise<CloudRequestPreview>
        generateSuggestions: (requestId: string, mediaId: string, segments: TranscriptSegment[], forceRegenerate: boolean) => Promise<IpcResult<GenerateSuggestionsResult>>
        cancelRequest: (requestId: string) => Promise<boolean>
        regenerateSuggestion: (requestId: string, mediaId: string, segment: TranscriptSegment) => Promise<IpcResult<AiSuggestion | null>>
        simplifySuggestion: (requestId: string, text: string) => Promise<IpcResult<string>>
        transformScript: (requestId: string, text: string, mode: ScriptTransformMode) => Promise<IpcResult<string>>
      }
      localAi: {
        getHealth: () => Promise<LocalAiHealth>
        listModels: () => Promise<LocalAiIpcResult<LocalModelInfo[]>>
        pullModel: (requestId: string, model: string) => Promise<void>
        retryPull: (requestId: string, model: string) => Promise<void>
        cancelPull: (requestId: string) => Promise<boolean>
        unloadModel: (model: string) => Promise<void>
        onPullProgress: (callback: (p: ModelPullProgress) => void) => (() => void)
        generateScenePlan: (requestId: string, mediaId: string, segments: TranscriptSegment[], mediaDurationSeconds: number, model: string, options?: ScenePlanGenerationOptions) => Promise<LocalAiIpcResult<GenerateScenePlanResult>>
        cancelGenerate: (requestId: string) => Promise<boolean>
      }
      story: {
        previewAnalysis: (segments: TranscriptSegment[]) => Promise<CloudRequestPreview>
        analyzeStory: (requestId: string, mediaId: string, segments: TranscriptSegment[], mediaDurationSeconds: number, creativity: number) => Promise<StoryIpcResult<GenerateNarrativeGraphResult>>
        cancelAnalysis: (requestId: string) => Promise<boolean>
      }
      export: {
        pickOutputDir: () => Promise<{
          canceled: boolean
          path?: string
        }>
        getCapabilities: () => Promise<ExportCapabilities>
        startExport: (requestId: string, sequence: ProjectSequence, mediaById: Record<string, {
          originalPath: string
        }>, aspectRatio: "16:9" | "9:16" | "1:1", options: ExportOptions, overlay?: import('@shared/videoOverlay').ExportOverlay) => Promise<void>
        cancelExport: (requestId: string) => Promise<boolean>
        openOutput: (outputPath: string) => Promise<boolean>
        writeTextFile: (dir: string, name: string, extension: string, content: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
        onProgress: (callback: (p: ExportProgress) => void) => (() => void)
      }
      windowControls: {
        minimize: () => Promise<void>
        maximizeToggle: () => Promise<void>
        close: () => Promise<void>
        isMaximized: () => Promise<boolean>
        setMode: (mode: 'home' | 'editor') => Promise<void>
        onMaximizedChanged: (callback: (maximized: boolean) => void) => (() => void)
      }
      updater: {
        check: () => Promise<void>
        quitAndInstall: () => Promise<void>
        onStatus: (callback: (status: UpdaterStatus) => void) => (() => void)
      }
      narration: {
        detectSpeaker: (jobId: string, sourcePath: string, startTime: number, endTime: number) => Promise<DetectSpeakerResult>
        optimizeTake: (jobId: string, filePath: string, settings: NarrationOptimizationSettings) => Promise<{
          applied: boolean
        }>
      }
      dubbing: {
        /** AI Dubber's ORIGINAL "Generate Dubbing" placeholder step -- returns the
         * saved path of a new audio file (that subtitle's own original-audio
         * slice). Kept as an unused-by-default fallback for whenever VoxCPM2
         * isn't installed/validated -- see app/main/media/dubbingAudio.ts. */
        extractPlaceholderClip: (jobId: string, sourcePath: string, startTime: number, endTime: number) => Promise<string>
        /** Checks a VoxCPM2 portable install directory has every required
         * file/folder -- see app/main/media/voxcpmTts.ts's validateVoxCpmInstall. */
        validateInstall: (installDir: string) => Promise<ValidateVoxCpmInstallResult>
        detectInstalls: (knownPath?: string) => Promise<string[]>
        pickInstallFolder: () => Promise<string | null>
        /** AI Dubber's Add button: one dialog for video(s) and/or an .srt. */
        pickVideosAndSrt: () => Promise<{ videoPaths: string[]; srt: { fileName: string; srtText: string } | null; srts: { fileName: string; srtText: string }[] }>
        /** Echo/reverb score (0..1) of each line in the video's own audio -- inner-voice detection. */
        detectEchoLines: (args: { originalPath: string; lines: { id: string; startTime: number; endTime: number }[] }) => Promise<{ id: string; score: number }[]>
        /** Playable URL for a generated audio file (the voice test). */
        audioUrl: (filePath: string) => Promise<string | null>
        renderAudioEffect: (jobId: string, inputPath: string, start: number, end: number, filter: string) => Promise<{ ok: true; outputPath: string } | { ok: false; error: string }>
        detectBurnedSubtitles: (videoPath: string, lineMiddles: number[]) => Promise<{ x: number; y: number; w: number; h: number; score: number } | null>
        /** Series mode: folder picker, then one `<video name>.srt` per episode. */
        saveEpisodeSrts: (files: { fileName: string; srtText: string }[]) => Promise<{ folder: string; written: number } | null>
        /** Runs real VoxCPM2 generation over every voice group in `request`,
         * sequentially. Resolves once every group has been attempted per-line
         * results stream separately via `onGenerationProgress` as they complete
         * (see that channel's own doc comment in shared/dubbing.ts for why). */
        generateBatch: (request: DubbingGenerationRequest) => Promise<void>
        cancelGeneration: (batchId?: string) => Promise<boolean>
        analyzePerformance: (jobId: string, lines: AnalyzePerformanceLine[]) => Promise<AnalyzePerformanceResult>
        stitchAudio: (inputPaths: string[], gapSeconds: number, level?: boolean) => Promise<{
          ok: true
          outputPath: string
        } | {
          ok: false
          error: string
        }>
        refitClipAudio: (jobId: string, sourcePath: string, speed: number) => Promise<RefitClipAudioResult>
        prepareReferenceClip: (jobId: string, sourcePath: string, installDir?: string, level?: boolean) => Promise<PrepareReferenceClipResult>
        onGenerationProgress: (callback: (event: DubbingGenerationProgressEvent) => void) => (() => void)
      }
      kiri: {
        hasKey: () => Promise<boolean>
        setKey: (key: string) => Promise<void>
        clearKey: () => Promise<void>
        listVoices: () => Promise<import('@shared/kiriTts').KiriListResult>
        cloneVoice: (name: string, sourcePath?: string, options?: import('@shared/kiriTts').KiriCloneOptions) => Promise<import('@shared/kiriTts').KiriCloneResult>
        pickCloneSource: () => Promise<import('@shared/kiriTts').KiriCloneSource>
      }
      videoStoryNarration: {
        hasApiKey: () => Promise<boolean>
        setApiKey: (key: string) => Promise<void>
        clearApiKey: () => Promise<void>
        analyze: (request: VideoStoryNarrationRequest) => Promise<VideoStoryNarrationIpcResult>
        buildOutline: (request: StoryOutlineRequest) => Promise<StoryOutlineIpcResult>
        writeScript: (request: StoryScriptRequest) => Promise<VideoStoryNarrationIpcResult>
        libraryGet: () => Promise<StoryLibrary>
        librarySave: (library: StoryLibrary) => Promise<StoryLibrary>
        regenerateScene: (request: RegenerateNarrationSceneRequest) => Promise<{ ok: true; data: VideoStoryNarrationScene } | { ok: false; error: string }>
        cancel: (jobId: string) => Promise<boolean>
        exportTxt: (scenes: VideoStoryNarrationScene[]) => Promise<string | null>
        exportSrt: (scenes: VideoStoryNarrationScene[]) => Promise<string | null>
        onProgress: (callback: (progress: VideoStoryNarrationProgress) => void) => (() => void)
      }
      aiAnimation: {
        generate: (request: AnimationRequest) => Promise<AnimationIpcResult>
        cancel: (jobId: string) => Promise<boolean>
        openFolder: (folder: string) => Promise<boolean>
        saveSrt: (srtPath: string) => Promise<string | null>
        onProgress: (callback: (progress: AnimationProgress) => void) => (() => void)
      }
      translation: {
        previewTranslation: (segments: TranscriptSegment[]) => Promise<CloudRequestPreview>
        translateSubtitles: (requestId: string, segments: TranscriptSegment[], targetLanguage: string) => Promise<TranslationIpcResult<TranslateSubtitlesResult>>
        cancelTranslation: (requestId: string) => Promise<boolean>
      }
      vocalRemoval: {
        removeVocals: (jobId: string, sourcePath: string, installDir?: string, device?: VoxCpmDevice) => Promise<RemoveVocalsResult>
        cancel: (jobId: string) => Promise<boolean>
        onProgress: (callback: (progress: VocalRemovalProgress) => void) => (() => void)
      }
      license: {
        getStatus: () => Promise<LicenseStatus>
        activate: (key: string) => Promise<ActivateLicenseResult>
        deactivate: () => Promise<LicenseStatus>
        onStatusChanged: (callback: (status: LicenseStatus) => void) => (() => void)
      }
      reportCrash: (report: CrashReport) => Promise<void>
    }
  }
}
