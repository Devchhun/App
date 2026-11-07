import type { LogoTemplate, RemoveBackgroundProgress, RemoveBackgroundResult } from '@shared/media'
import { KIRI_IPC, type KiriCloneResult, type KiriListResult } from '@shared/kiriTts'
import type { CastScanLine, CastScanProgress, CastScanRequest, CastScanResult } from '@shared/cast'
import type { ExportOverlay } from '@shared/videoOverlay'
import { AI_ANIMATION_IPC, type AnimationIpcResult, type AnimationProgress, type AnimationRequest } from '@shared/aiAnimation'
import { MANGA_IPC, type MangaIpcResult, type MangaProgress, type MangaRequest, type MangaScenesResult } from '@shared/mangaRecap'
import { AI_EDIT_IPC } from '@shared/aiEditing'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { MEDIA_IPC } from '@shared/media'
import type { FfmpegAvailability, MediaItem, MediaProgressUpdate, SaveClipAudioRequest, WaveformData } from '@shared/media'
import { TRANSCRIPTION_IPC } from '@shared/transcription'
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
  CorrectionCategory,
  DetectSpeakersRequest,
  DetectSpeakersResult,
  DetectSpeakersProgress,
  SpeakerGender
} from '@shared/transcription'
import { PROJECT_IPC } from '@shared/project'
import type { ProjectFile, MediaSource, ProjectSequence, ProjectSummary } from '@shared/project'
import type { ProvisionProgress } from '../main/ai/provisionVenv'
import { AI_IPC } from '@shared/suggestions'
import type { AiSuggestion, CloudRequestPreview, GenerateSuggestionsResult, GenerateSuggestionsError, ScriptTransformMode } from '@shared/suggestions'
import { LOCAL_AI_IPC } from '@shared/localAi'
import type { LocalAiHealth, LocalModelInfo, ModelPullProgress, GenerateScenePlanResult, LocalAiError, ScenePlanGenerationOptions } from '@shared/localAi'
import { STORY_IPC } from '@shared/story'
import type { GenerateNarrativeGraphResult, StoryAnalysisError } from '@shared/story'
import { EXPORT_IPC } from '@shared/export'
import type { ExportOptions, ExportProgress, ExportCapabilities } from '@shared/export'
import { WINDOW_IPC } from '@shared/window'
import { UPDATER_IPC } from '@shared/updater'
import type { UpdaterStatus } from '@shared/updater'
import { CRASH_IPC } from '@shared/crash'
import { LICENSE_IPC } from '@shared/license'
import type { LicenseStatus, ActivateLicenseResult } from '@shared/license'
import type { CrashReport } from '@shared/crash'
import { NARRATION_IPC } from '@shared/narration'
import type { DetectSpeakerResult, NarrationOptimizationSettings } from '@shared/narration'
import { DUBBING_IPC, type RefitClipAudioResult, type PrepareReferenceClipResult, type VoxCpmDevice } from '@shared/dubbing'
import type { ValidateVoxCpmInstallResult, DubbingGenerationRequest, DubbingGenerationProgressEvent, AnalyzePerformanceLine, AnalyzePerformanceResult } from '@shared/dubbing'
import { VIDEO_STORY_NARRATION_IPC, type RegenerateNarrationSceneRequest, type StoryLibrary, type StoryOutlineIpcResult, type StoryOutlineRequest, type StoryScriptRequest, type VideoStoryNarrationIpcResult, type VideoStoryNarrationProgress, type VideoStoryNarrationRequest, type VideoStoryNarrationScene } from '@shared/videoStoryNarration'
import { VOCAL_REMOVAL_IPC, type RemoveVocalsResult, type SpeechRange, type VocalRemovalProgress } from '@shared/vocalRemoval'
import { REFRAME_IPC, type ReframeAnalyzeResult, type ReframeProgress } from '@shared/reframe'
import { TRANSLATION_IPC } from '@shared/translation'
import type { TranslateSubtitlesResult, TranslationError } from '@shared/translation'

const mediaApi = {
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(MEDIA_IPC.pickFiles),
  imageUrl: (filePath: string): Promise<string | null> => ipcRenderer.invoke(MEDIA_IPC.imageUrl, filePath),
  removeBackground: (jobId: string, imagePath: string): Promise<RemoveBackgroundResult> => ipcRenderer.invoke(MEDIA_IPC.removeBackground, { jobId, imagePath }),
  cancelRemoveBackground: (jobId: string): Promise<boolean> => ipcRenderer.invoke(MEDIA_IPC.cancelRemoveBackground, jobId),
  onRemoveBackgroundProgress: (callback: (progress: RemoveBackgroundProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: RemoveBackgroundProgress): void => callback(progress)
    ipcRenderer.on(MEDIA_IPC.removeBackgroundProgress, listener)
    return () => ipcRenderer.removeListener(MEDIA_IPC.removeBackgroundProgress, listener)
  },
  importPaths: (paths: string[]): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.importPaths, paths),
  cancelJob: (mediaId: string): Promise<boolean> => ipcRenderer.invoke(MEDIA_IPC.cancelJob, mediaId),
  retryJob: (mediaId: string): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.retryJob, mediaId),
  getFfmpegStatus: (): Promise<FfmpegAvailability> => ipcRenderer.invoke(MEDIA_IPC.ffmpegStatus),
  rehydrate: (sources: MediaSource[]): Promise<MediaItem[]> => ipcRenderer.invoke(MEDIA_IPC.rehydrate, sources),
  pickCoverImage: (): Promise<string | null> => ipcRenderer.invoke(MEDIA_IPC.pickCoverImage),
  listLogoTemplates: (): Promise<LogoTemplate[]> => ipcRenderer.invoke(MEDIA_IPC.listLogoTemplates),
  addLogoTemplate: (): Promise<LogoTemplate | null> => ipcRenderer.invoke(MEDIA_IPC.addLogoTemplate),
  removeLogoTemplate: (id: string): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.removeLogoTemplate, id),
  saveGeneratedFile: (fileName: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke(MEDIA_IPC.saveGeneratedFile, fileName, data),
  saveStillFrame: (dirPath: string, fileName: string, data: Uint8Array): Promise<string> => ipcRenderer.invoke(MEDIA_IPC.saveStillFrame, { dirPath, fileName, data }),
  getDefaultStillDir: (): Promise<string> => ipcRenderer.invoke(MEDIA_IPC.getDefaultStillDir),
  saveClipAudio: (request: SaveClipAudioRequest): Promise<string | null> => ipcRenderer.invoke(MEDIA_IPC.saveClipAudio, request),
  ensureWaveform: (mediaId: string, originalPath: string): Promise<WaveformData | null> => ipcRenderer.invoke(MEDIA_IPC.ensureWaveform, { mediaId, originalPath }),
  onProgress: (callback: (update: MediaProgressUpdate) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: MediaProgressUpdate): void => callback(update)
    ipcRenderer.on(MEDIA_IPC.progress, listener)
    return () => ipcRenderer.removeListener(MEDIA_IPC.progress, listener)
  },
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

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

const transcriptionApi = {
  getDeviceInfo: (): Promise<DeviceInfo> => ipcRenderer.invoke(TRANSCRIPTION_IPC.getDeviceInfo),
  retryGpuDetection: (): Promise<DeviceInfo> => ipcRenderer.invoke(TRANSCRIPTION_IPC.retryGpuDetection),
  verifyGpu: (): Promise<GpuVerificationResult> => ipcRenderer.invoke(TRANSCRIPTION_IPC.verifyGpu),
  listModels: (): Promise<ModelStatus[]> => ipcRenderer.invoke(TRANSCRIPTION_IPC.listModels),
  downloadModel: (modelId: WhisperModelSize): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.downloadModel, modelId),
  cancelModelDownload: (): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.cancelModelDownload),
  onModelDownloadProgress: (callback: (p: ModelDownloadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: ModelDownloadProgress): void => callback(p)
    ipcRenderer.on(TRANSCRIPTION_IPC.modelDownloadProgress, listener)
    return () => ipcRenderer.removeListener(TRANSCRIPTION_IPC.modelDownloadProgress, listener)
  },
  start: (params: StartTranscriptionParams): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.start, params),
  pause: (): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.pause),
  resume: (): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.resume),
  cancel: (): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.cancel),
  retry: (mediaId: string): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.retry, mediaId),
  onProgress: (callback: (update: TranscriptionProgressUpdate) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: TranscriptionProgressUpdate): void => callback(update)
    ipcRenderer.on(TRANSCRIPTION_IPC.progress, listener)
    return () => ipcRenderer.removeListener(TRANSCRIPTION_IPC.progress, listener)
  },
  alignScript: (scriptText: string, words: TranscriptWord[]): Promise<ScriptAlignmentSegment[]> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.alignScript, { scriptText, words }),
  getCorrectionDictionary: (): Promise<CorrectionDictionaryEntry[]> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.getCorrectionDictionary),
  addCorrectionEntry: (
    original: string,
    correction: string,
    category: CorrectionCategory,
    language: 'km' | 'en' | 'mixed'
  ): Promise<CorrectionDictionaryEntry> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.addCorrectionEntry, { original, correction, category, language }),
  updateCorrectionEntry: (id: string, updates: CorrectionEntryUpdates): Promise<CorrectionDictionaryEntry | null> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.updateCorrectionEntry, { id, updates }),
  removeCorrectionEntry: (id: string): Promise<void> => ipcRenderer.invoke(TRANSCRIPTION_IPC.removeCorrectionEntry, id),
  exportCorrectionDictionaryToFile: (): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.exportCorrectionDictionaryToFile),
  importCorrectionDictionaryFromFile: (
    mode: 'merge' | 'replace'
  ): Promise<{ canceled: boolean; entries?: CorrectionDictionaryEntry[] }> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.importCorrectionDictionaryFromFile, mode),
  importSrtFile: (options?: { multiple?: boolean }): Promise<{ canceled: boolean; fileName?: string; srtText?: string; files?: { fileName: string; srtText: string }[] }> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.importSrtFile, options),
  detectSpeakers: (request: DetectSpeakersRequest): Promise<DetectSpeakersResult> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.detectSpeakers, request),
  cancelDetectSpeakers: (jobId: string): Promise<boolean> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.cancelDetectSpeakers, jobId),
  onDetectSpeakersProgress: (callback: (progress: DetectSpeakersProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: DetectSpeakersProgress): void => callback(progress)
    ipcRenderer.on(TRANSCRIPTION_IPC.detectSpeakersProgress, listener)
    return () => ipcRenderer.removeListener(TRANSCRIPTION_IPC.detectSpeakersProgress, listener)
  },
  onWorkerStatus: (callback: (p: ProvisionProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: ProvisionProgress): void => callback(p)
    ipcRenderer.on(TRANSCRIPTION_IPC.workerStatus, listener)
    return () => ipcRenderer.removeListener(TRANSCRIPTION_IPC.workerStatus, listener)
  }
}

const projectApi = {
  getOrCreateStartup: (): Promise<ProjectFile> => ipcRenderer.invoke(PROJECT_IPC.getOrCreateStartup),
  save: (project: ProjectFile): Promise<string> => ipcRenderer.invoke(PROJECT_IPC.save, project),
  list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke(PROJECT_IPC.list),
  listTrash: (): Promise<ProjectSummary[]> => ipcRenderer.invoke(PROJECT_IPC.listTrash),
  create: (name: string): Promise<ProjectSummary> => ipcRenderer.invoke(PROJECT_IPC.create, name),
  open: (id: string): Promise<void> => ipcRenderer.invoke(PROJECT_IPC.open, id),
  rename: (id: string, name: string): Promise<void> => ipcRenderer.invoke(PROJECT_IPC.rename, { id, name }),
  trash: (id: string): Promise<void> => ipcRenderer.invoke(PROJECT_IPC.trash, id),
  restore: (id: string): Promise<void> => ipcRenderer.invoke(PROJECT_IPC.restore, id),
  deleteForever: (id: string): Promise<void> => ipcRenderer.invoke(PROJECT_IPC.deleteForever, id)
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: GenerateSuggestionsError }

const aiApi = {
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(AI_IPC.hasApiKey),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke(AI_IPC.setApiKey, key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke(AI_IPC.clearApiKey),
  previewCloudRequest: (segments: TranscriptSegment[]): Promise<CloudRequestPreview> =>
    ipcRenderer.invoke(AI_IPC.previewCloudRequest, segments),
  generateSuggestions: (
    requestId: string,
    mediaId: string,
    segments: TranscriptSegment[],
    forceRegenerate: boolean
  ): Promise<IpcResult<GenerateSuggestionsResult>> =>
    ipcRenderer.invoke(AI_IPC.generateSuggestions, { requestId, mediaId, segments, forceRegenerate }),
  cancelRequest: (requestId: string): Promise<boolean> => ipcRenderer.invoke(AI_IPC.cancelRequest, requestId),
  regenerateSuggestion: (
    requestId: string,
    mediaId: string,
    segment: TranscriptSegment
  ): Promise<IpcResult<AiSuggestion | null>> =>
    ipcRenderer.invoke(AI_IPC.regenerateSuggestion, { requestId, mediaId, segment }),
  simplifySuggestion: (requestId: string, text: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(AI_IPC.simplifySuggestion, { requestId, text }),
  transformScript: (requestId: string, text: string, mode: ScriptTransformMode): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(AI_IPC.transformScript, { requestId, text, mode })
}

const reframeApi = {
  analyze: (jobId: string, path: string): Promise<ReframeAnalyzeResult> => ipcRenderer.invoke(REFRAME_IPC.analyze, { jobId, path }),
  cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke(REFRAME_IPC.cancel, jobId),
  onProgress: (callback: (progress: ReframeProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ReframeProgress): void => callback(progress)
    ipcRenderer.on(REFRAME_IPC.progress, listener)
    return () => ipcRenderer.removeListener(REFRAME_IPC.progress, listener)
  }
}

const vocalRemovalApi = {
  removeVocals: (jobId: string, sourcePath: string, installDir?: string, device?: VoxCpmDevice): Promise<RemoveVocalsResult> =>
    ipcRenderer.invoke(VOCAL_REMOVAL_IPC.removeVocals, { jobId, sourcePath, installDir, device }),
  removeVocalsAtLines: (jobId: string, sourcePath: string, ranges: SpeechRange[], installDir?: string, device?: VoxCpmDevice): Promise<RemoveVocalsResult> =>
    ipcRenderer.invoke(VOCAL_REMOVAL_IPC.removeVocalsAtLines, { jobId, sourcePath, ranges, installDir, device }),
  cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke(VOCAL_REMOVAL_IPC.cancel, jobId),
  onProgress: (callback: (progress: VocalRemovalProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: VocalRemovalProgress): void => callback(progress)
    ipcRenderer.on(VOCAL_REMOVAL_IPC.progress, listener)
    return () => ipcRenderer.removeListener(VOCAL_REMOVAL_IPC.progress, listener)
  }
}

type TranslationIpcResult<T> = { ok: true; data: T } | { ok: false; error: TranslationError }

const translationApi = {
  previewTranslation: (segments: TranscriptSegment[]): Promise<CloudRequestPreview> => ipcRenderer.invoke(TRANSLATION_IPC.previewTranslation, segments),
  translateSubtitles: (requestId: string, segments: TranscriptSegment[], targetLanguage: string): Promise<TranslationIpcResult<TranslateSubtitlesResult>> =>
    ipcRenderer.invoke(TRANSLATION_IPC.translateSubtitles, { requestId, segments, targetLanguage }),
  cancelTranslation: (requestId: string): Promise<boolean> => ipcRenderer.invoke(TRANSLATION_IPC.cancelTranslation, requestId)
}

type LocalAiIpcResult<T> = { ok: true; data: T } | { ok: false; error: LocalAiError }

const localAiApi = {
  getHealth: (): Promise<LocalAiHealth> => ipcRenderer.invoke(LOCAL_AI_IPC.getHealth),
  listModels: (): Promise<LocalAiIpcResult<LocalModelInfo[]>> => ipcRenderer.invoke(LOCAL_AI_IPC.listModels),
  pullModel: (requestId: string, model: string): Promise<void> => ipcRenderer.invoke(LOCAL_AI_IPC.pullModel, { requestId, model }),
  retryPull: (requestId: string, model: string): Promise<void> => ipcRenderer.invoke(LOCAL_AI_IPC.retryPull, { requestId, model }),
  cancelPull: (requestId: string): Promise<boolean> => ipcRenderer.invoke(LOCAL_AI_IPC.cancelPull, requestId),
  unloadModel: (model: string): Promise<void> => ipcRenderer.invoke(LOCAL_AI_IPC.unloadModel, model),
  onPullProgress: (callback: (p: ModelPullProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: ModelPullProgress): void => callback(p)
    ipcRenderer.on(LOCAL_AI_IPC.pullProgress, listener)
    return () => ipcRenderer.removeListener(LOCAL_AI_IPC.pullProgress, listener)
  },
  generateScenePlan: (
    requestId: string,
    mediaId: string,
    segments: TranscriptSegment[],
    mediaDurationSeconds: number,
    model: string,
    options?: ScenePlanGenerationOptions
  ): Promise<LocalAiIpcResult<GenerateScenePlanResult>> =>
    ipcRenderer.invoke(LOCAL_AI_IPC.generateScenePlan, { requestId, mediaId, segments, mediaDurationSeconds, model, options }),
  cancelGenerate: (requestId: string): Promise<boolean> => ipcRenderer.invoke(LOCAL_AI_IPC.cancelGenerate, requestId)
}

type StoryIpcResult<T> = { ok: true; data: T } | { ok: false; error: StoryAnalysisError }

const storyApi = {
  previewAnalysis: (segments: TranscriptSegment[]): Promise<CloudRequestPreview> => ipcRenderer.invoke(STORY_IPC.previewAnalysis, segments),
  analyzeStory: (
    requestId: string,
    mediaId: string,
    segments: TranscriptSegment[],
    mediaDurationSeconds: number,
    creativity: number
  ): Promise<StoryIpcResult<GenerateNarrativeGraphResult>> =>
    ipcRenderer.invoke(STORY_IPC.analyzeStory, { requestId, mediaId, segments, mediaDurationSeconds, creativity }),
  cancelAnalysis: (requestId: string): Promise<boolean> => ipcRenderer.invoke(STORY_IPC.cancelAnalysis, requestId)
}

const kiriApi = {
  hasKey: (): Promise<boolean> => ipcRenderer.invoke(KIRI_IPC.hasKey),
  setKey: (key: string): Promise<void> => ipcRenderer.invoke(KIRI_IPC.setKey, key),
  clearKey: (): Promise<void> => ipcRenderer.invoke(KIRI_IPC.clearKey),
  listVoices: (): Promise<KiriListResult> => ipcRenderer.invoke(KIRI_IPC.listVoices),
  cloneVoice: (name: string, sourcePath?: string, options?: import('@shared/kiriTts').KiriCloneOptions): Promise<KiriCloneResult> => ipcRenderer.invoke(KIRI_IPC.cloneVoice, { name, sourcePath, options }),
  pickCloneSource: (): Promise<import('@shared/kiriTts').KiriCloneSource> => ipcRenderer.invoke(KIRI_IPC.pickCloneSource),
  voiceSample: (voice: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => ipcRenderer.invoke(KIRI_IPC.voiceSample, voice)
}

const exportApi = {
  pickOutputDir: (): Promise<{ canceled: boolean; path?: string }> => ipcRenderer.invoke(EXPORT_IPC.pickOutputDir),
  getCapabilities: (): Promise<ExportCapabilities> => ipcRenderer.invoke(EXPORT_IPC.getCapabilities),
  startExport: (
    requestId: string,
    sequence: ProjectSequence,
    mediaById: Record<string, { originalPath: string }>,
    aspectRatio: '16:9' | '9:16' | '1:1',
    options: ExportOptions,
    overlay?: ExportOverlay
  ): Promise<void> => ipcRenderer.invoke(EXPORT_IPC.startExport, { requestId, sequence, mediaById, aspectRatio, options, overlay }),
  cancelExport: (requestId: string): Promise<boolean> => ipcRenderer.invoke(EXPORT_IPC.cancelExport, requestId),
  openOutput: (outputPath: string): Promise<boolean> => ipcRenderer.invoke(EXPORT_IPC.openOutput, outputPath),
  writeTextFile: (dir: string, name: string, extension: string, content: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(EXPORT_IPC.writeTextFile, { dir, name, extension, content }),
  onProgress: (callback: (p: ExportProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: ExportProgress): void => callback(p)
    ipcRenderer.on(EXPORT_IPC.progress, listener)
    return () => ipcRenderer.removeListener(EXPORT_IPC.progress, listener)
  }
}

const windowControlsApi = {
  minimize: (): Promise<void> => ipcRenderer.invoke(WINDOW_IPC.minimize),
  maximizeToggle: (): Promise<void> => ipcRenderer.invoke(WINDOW_IPC.maximizeToggle),
  close: (): Promise<void> => ipcRenderer.invoke(WINDOW_IPC.close),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(WINDOW_IPC.isMaximized),
  setMode: (mode: 'home' | 'editor'): Promise<void> => ipcRenderer.invoke(WINDOW_IPC.setMode, mode),
  onMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on(WINDOW_IPC.maximizedChanged, listener)
    return () => ipcRenderer.removeListener(WINDOW_IPC.maximizedChanged, listener)
  }
}

const updaterApi = {
  check: (): Promise<void> => ipcRenderer.invoke(UPDATER_IPC.check),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke(UPDATER_IPC.quitAndInstall),
  onStatus: (callback: (status: UpdaterStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdaterStatus): void => callback(status)
    ipcRenderer.on(UPDATER_IPC.status, listener)
    return () => ipcRenderer.removeListener(UPDATER_IPC.status, listener)
  }
}

const narrationApi = {
  detectSpeaker: (jobId: string, sourcePath: string, startTime: number, endTime: number): Promise<DetectSpeakerResult> =>
    ipcRenderer.invoke(NARRATION_IPC.detectSpeaker, { jobId, sourcePath, startTime, endTime }),
  optimizeTake: (jobId: string, filePath: string, settings: NarrationOptimizationSettings): Promise<{ applied: boolean }> =>
    ipcRenderer.invoke(NARRATION_IPC.optimizeTake, { jobId, filePath, settings })
}

const dubbingApi = {
  /** AI Dubber's ORIGINAL "Generate Dubbing" placeholder step -- returns the
   * saved path of a new audio file (that subtitle's own original-audio
   * slice). Kept as an unused-by-default fallback for whenever VoxCPM2
   * isn't installed/validated -- see app/main/media/dubbingAudio.ts. */
  extractPlaceholderClip: (jobId: string, sourcePath: string, startTime: number, endTime: number): Promise<string> =>
    ipcRenderer.invoke(DUBBING_IPC.extractPlaceholderClip, { jobId, sourcePath, startTime, endTime }),
  /** Checks a VoxCPM2 portable install directory has every required
   * file/folder -- see app/main/media/voxcpmTts.ts's validateVoxCpmInstall. */
  validateInstall: (installDir: string): Promise<ValidateVoxCpmInstallResult> => ipcRenderer.invoke(DUBBING_IPC.validateInstall, installDir),
  detectInstalls: (knownPath?: string): Promise<string[]> => ipcRenderer.invoke(DUBBING_IPC.detectInstalls, knownPath),
  pickInstallFolder: (): Promise<string | null> => ipcRenderer.invoke(DUBBING_IPC.pickInstallFolder),
  pickVideosAndSrt: (): Promise<{ videoPaths: string[]; srt: { fileName: string; srtText: string } | null; srts: { fileName: string; srtText: string }[] }> => ipcRenderer.invoke(DUBBING_IPC.pickVideosAndSrt),
  detectEchoLines: (args: { originalPath: string; lines: { id: string; startTime: number; endTime: number }[] }): Promise<{ id: string; score: number }[]> =>
    ipcRenderer.invoke(DUBBING_IPC.detectEchoLines, args),
  audioUrl: (filePath: string): Promise<string | null> => ipcRenderer.invoke(DUBBING_IPC.audioUrl, filePath),
  renderAudioEffect: (jobId: string, inputPath: string, start: number, end: number, filter: string): Promise<{ ok: true; outputPath: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(DUBBING_IPC.renderAudioEffect, { jobId, inputPath, start, end, filter }),
  detectBurnedSubtitles: (videoPath: string, lineMiddles: number[]): Promise<{ x: number; y: number; w: number; h: number; score: number } | null> =>
    ipcRenderer.invoke(DUBBING_IPC.detectBurnedSubtitles, { videoPath, lineMiddles }),
  saveEpisodeSrts: (files: { fileName: string; srtText: string }[]): Promise<{ folder: string; written: number } | null> =>
    ipcRenderer.invoke(DUBBING_IPC.saveEpisodeSrts, files),
  /** Runs real VoxCPM2 generation over every voice group in `request`,
   * sequentially. Resolves once every group has been attempted; per-line
   * results stream separately via `onGenerationProgress` as they complete
   * (see that channel's own doc comment in shared/dubbing.ts for why). */
  generateBatch: (request: DubbingGenerationRequest): Promise<void> => ipcRenderer.invoke(DUBBING_IPC.generateBatch, request),
  cancelGeneration: (batchId?: string): Promise<boolean> => ipcRenderer.invoke(DUBBING_IPC.cancelGeneration, batchId),
  /** Emotion + performance per line, by Gemini, each line with its context. */
  analyzePerformance: (jobId: string, lines: AnalyzePerformanceLine[]): Promise<AnalyzePerformanceResult> =>
    ipcRenderer.invoke(DUBBING_IPC.analyzePerformance, { jobId, lines }),
  stitchAudio: (inputPaths: string[], gapSeconds: number, level = false): Promise<{ ok: true; outputPath: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(DUBBING_IPC.stitchAudio, { inputPaths, gapSeconds, level }),
  refitClipAudio: (jobId: string, sourcePath: string, speed: number): Promise<RefitClipAudioResult> =>
    ipcRenderer.invoke(DUBBING_IPC.refitClipAudio, { jobId, sourcePath, speed }),
  /** `level`: "even voice" -- trim, even out and peak-limit the clip
   * before it becomes the reference (see app/main/media/voiceLeveling.ts). */
  prepareReferenceClip: (jobId: string, sourcePath: string, installDir?: string, level = false): Promise<PrepareReferenceClipResult> =>
    ipcRenderer.invoke(DUBBING_IPC.prepareReferenceClip, { jobId, sourcePath, installDir, level }),
  onGenerationProgress: (callback: (event: DubbingGenerationProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DubbingGenerationProgressEvent): void => callback(payload)
    ipcRenderer.on(DUBBING_IPC.generationProgress, listener)
    return () => ipcRenderer.removeListener(DUBBING_IPC.generationProgress, listener)
  },
  /** The Cast window's scan: the voices of the given lines, grouped, each
   * with faces -- see shared/cast.ts. */
  scanCast: (request: CastScanRequest): Promise<{ ok: true; result: CastScanResult } | { ok: false; error: string; canceled?: boolean }> =>
    ipcRenderer.invoke(DUBBING_IPC.scanCast, request),
  cancelCast: (jobId: string): Promise<boolean> => ipcRenderer.invoke(DUBBING_IPC.cancelCast, jobId),
  /** Male or female for every given line (voice prints, grouped by voice). */
  detectGenders: (request: { jobId: string; lines: CastScanLine[] }): Promise<{ ok: true; genders: Record<string, { gender: SpeakerGender; confidence: number }> } | { ok: false; error: string }> =>
    ipcRenderer.invoke(DUBBING_IPC.detectGenders, request),
  onCastProgress: (callback: (progress: CastScanProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CastScanProgress): void => callback(payload)
    ipcRenderer.on(DUBBING_IPC.castProgress, listener)
    return () => ipcRenderer.removeListener(DUBBING_IPC.castProgress, listener)
  }
}

const videoStoryNarrationApi = {
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.hasApiKey),
  setApiKey: (key: string): Promise<number> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.setApiKey, key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.clearApiKey),
  checkApiKeys: (): Promise<{ mask: string; state: 'ok' | 'refused' | 'unknown'; note: string }[]> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.checkApiKeys),
  routerStatus: (): Promise<import('@shared/geminiKeyPool').GeminiRouterSnapshot> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.routerStatus),
  testRouterKeys: (): Promise<import('@shared/geminiKeyPool').GeminiRouterSnapshot> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.testRouterKeys),
  analyze: (request: VideoStoryNarrationRequest): Promise<VideoStoryNarrationIpcResult> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.analyze, request),
  buildOutline: (request: StoryOutlineRequest): Promise<StoryOutlineIpcResult> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.buildOutline, request),
  writeScript: (request: StoryScriptRequest): Promise<VideoStoryNarrationIpcResult> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.writeScript, request),
  libraryGet: (): Promise<StoryLibrary> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.libraryGet),
  librarySave: (library: StoryLibrary): Promise<StoryLibrary> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.librarySave, library),
  regenerateScene: (request: RegenerateNarrationSceneRequest): Promise<{ ok: true; data: VideoStoryNarrationScene } | { ok: false; error: string }> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.regenerateScene, request),
  cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.cancel, jobId),
  exportTxt: (scenes: VideoStoryNarrationScene[]): Promise<string | null> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.exportTxt, scenes),
  exportSrt: (scenes: VideoStoryNarrationScene[]): Promise<string | null> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.exportSrt, scenes),
  onProgress: (callback: (progress: VideoStoryNarrationProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: VideoStoryNarrationProgress): void => callback(progress)
    ipcRenderer.on(VIDEO_STORY_NARRATION_IPC.progress, listener)
    return () => ipcRenderer.removeListener(VIDEO_STORY_NARRATION_IPC.progress, listener)
  }
}

const aiAnimationApi = {
  generate: (request: AnimationRequest): Promise<AnimationIpcResult> => ipcRenderer.invoke(AI_ANIMATION_IPC.generate, request),
  cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke(AI_ANIMATION_IPC.cancel, jobId),
  openFolder: (folder: string): Promise<boolean> => ipcRenderer.invoke(AI_ANIMATION_IPC.openFolder, folder),
  saveSrt: (srtPath: string): Promise<string | null> => ipcRenderer.invoke(AI_ANIMATION_IPC.saveSrt, srtPath),
  onProgress: (callback: (progress: AnimationProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: AnimationProgress): void => callback(progress)
    ipcRenderer.on(AI_ANIMATION_IPC.progress, listener)
    return () => ipcRenderer.removeListener(AI_ANIMATION_IPC.progress, listener)
  }
}

const aiEditingApi = {
  listProjects: (): Promise<import('@shared/aiEditing').AiEditResult<import('@shared/aiEditing').TrainingProjectSummary[]>> =>
    ipcRenderer.invoke(AI_EDIT_IPC.listProjects),
  createProject: (name: string) => ipcRenderer.invoke(AI_EDIT_IPC.createProject, name),
  getProject: (id: string) => ipcRenderer.invoke(AI_EDIT_IPC.getProject, id),
  deleteProject: (id: string) => ipcRenderer.invoke(AI_EDIT_IPC.deleteProject, id),
  renameProject: (id: string, name: string) => ipcRenderer.invoke(AI_EDIT_IPC.renameProject, id, name),
  pickVideo: (title: string): Promise<string | null> => ipcRenderer.invoke(AI_EDIT_IPC.pickVideo, title),
  pickVideos: (title: string): Promise<string[]> => ipcRenderer.invoke(AI_EDIT_IPC.pickVideos, title),
  pickVideoFolder: (title: string): Promise<string[]> => ipcRenderer.invoke(AI_EDIT_IPC.pickVideoFolder, title),
  addPair: (projectId: string, original: string, edited: string, options?: { name?: string; narrationAudioPath?: string; scriptPath?: string }) =>
    ipcRenderer.invoke(AI_EDIT_IPC.addPair, projectId, original, edited, options ?? {}),
  addPairs: (projectId: string, originals: string[], editeds: string[]) => ipcRenderer.invoke(AI_EDIT_IPC.addPairs, projectId, originals, editeds),
  removePair: (projectId: string, pairId: string) => ipcRenderer.invoke(AI_EDIT_IPC.removePair, projectId, pairId),
  analyzePair: (projectId: string, pairId: string) => ipcRenderer.invoke(AI_EDIT_IPC.analyzePair, projectId, pairId),
  transcribeNarration: (projectId: string, pairId: string, modelId: string) => ipcRenderer.invoke(AI_EDIT_IPC.transcribeNarration, projectId, pairId, modelId),
  autoEdit: (projectId: string, sourceVideoPath: string, narrationPath: string, modelId: string): Promise<import('@shared/aiEditing').AiEditResult<import('@shared/autoEdit').AutoEditResult>> =>
    ipcRenderer.invoke(AI_EDIT_IPC.autoEdit, projectId, sourceVideoPath, narrationPath, modelId),
  cancelAnalyze: (pairId: string): Promise<boolean> => ipcRenderer.invoke(AI_EDIT_IPC.cancelAnalyze, pairId),
  onProgress: (callback: (progress: import('@shared/aiEditing').AiEditProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: import('@shared/aiEditing').AiEditProgress): void => callback(progress)
    ipcRenderer.on(AI_EDIT_IPC.progress, listener)
    return () => ipcRenderer.removeListener(AI_EDIT_IPC.progress, listener)
  },
}

const mangaApi = {
  pickImages: (): Promise<string[]> => ipcRenderer.invoke(MANGA_IPC.pickImages),
  thumbs: (paths: string[]): Promise<string[]> => ipcRenderer.invoke(MANGA_IPC.thumbs, paths),
  episodes: (link: string): Promise<import('@shared/mangaRecap').MangaEpisodesResult> => ipcRenderer.invoke(MANGA_IPC.episodes, link),
  getChapter: (jobId: string, pageUrl: string): Promise<MangaScenesResult> => ipcRenderer.invoke(MANGA_IPC.getChapter, jobId, pageUrl),
  cutScenes: (jobId: string, paths: string[]): Promise<MangaScenesResult> => ipcRenderer.invoke(MANGA_IPC.cutScenes, jobId, paths),
  backdrops: (jobId: string, paths: string[]): Promise<string[]> => ipcRenderer.invoke(MANGA_IPC.backdrops, jobId, paths),
  generate: (request: MangaRequest): Promise<MangaIpcResult> => ipcRenderer.invoke(MANGA_IPC.generate, request),
  cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke(MANGA_IPC.cancel, jobId),
  onProgress: (callback: (progress: MangaProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: MangaProgress): void => callback(progress)
    ipcRenderer.on(MANGA_IPC.progress, listener)
    return () => ipcRenderer.removeListener(MANGA_IPC.progress, listener)
  }
}

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  media: mediaApi,
  transcription: transcriptionApi,
  project: projectApi,
  ai: aiApi,
  localAi: localAiApi,
  story: storyApi,
  export: exportApi,
  kiri: kiriApi,
  windowControls: windowControlsApi,
  updater: updaterApi,
  narration: narrationApi,
  dubbing: dubbingApi,
  videoStoryNarration: videoStoryNarrationApi,
  aiAnimation: aiAnimationApi,
  manga: mangaApi,
  aiEditing: aiEditingApi,
  translation: translationApi,
  vocalRemoval: vocalRemovalApi,
  reframe: reframeApi,
  license: {
    getStatus: (): Promise<LicenseStatus> => ipcRenderer.invoke(LICENSE_IPC.getStatus),
    activate: (key: string): Promise<ActivateLicenseResult> => ipcRenderer.invoke(LICENSE_IPC.activate, key),
    deactivate: (): Promise<LicenseStatus> => ipcRenderer.invoke(LICENSE_IPC.deactivate),
    onStatusChanged: (callback: (status: LicenseStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: LicenseStatus): void => callback(status)
      ipcRenderer.on(LICENSE_IPC.statusChanged, listener)
      return () => ipcRenderer.removeListener(LICENSE_IPC.statusChanged, listener)
    }
  },
  reportCrash: (report: CrashReport): Promise<void> => ipcRenderer.invoke(CRASH_IPC.report, report)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type Api = typeof api
