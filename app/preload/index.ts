import { AI_ANIMATION_IPC, type AnimationIpcResult, type AnimationProgress, type AnimationRequest } from '@shared/aiAnimation'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { MEDIA_IPC } from '@shared/media'
import type { FfmpegAvailability, MediaItem, MediaProgressUpdate, WaveformData } from '@shared/media'
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
  DetectSpeakersProgress
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
import type { ValidateVoxCpmInstallResult, DubbingGenerationRequest, DubbingGenerationProgressEvent } from '@shared/dubbing'
import { VIDEO_STORY_NARRATION_IPC, type RegenerateNarrationSceneRequest, type StoryLibrary, type StoryOutlineIpcResult, type StoryOutlineRequest, type StoryScriptRequest, type VideoStoryNarrationIpcResult, type VideoStoryNarrationProgress, type VideoStoryNarrationRequest, type VideoStoryNarrationScene } from '@shared/videoStoryNarration'
import { VOCAL_REMOVAL_IPC, type RemoveVocalsResult, type VocalRemovalProgress } from '@shared/vocalRemoval'
import { TRANSLATION_IPC } from '@shared/translation'
import type { TranslateSubtitlesResult, TranslationError } from '@shared/translation'

const mediaApi = {
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(MEDIA_IPC.pickFiles),
  importPaths: (paths: string[]): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.importPaths, paths),
  cancelJob: (mediaId: string): Promise<boolean> => ipcRenderer.invoke(MEDIA_IPC.cancelJob, mediaId),
  retryJob: (mediaId: string): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.retryJob, mediaId),
  getFfmpegStatus: (): Promise<FfmpegAvailability> => ipcRenderer.invoke(MEDIA_IPC.ffmpegStatus),
  rehydrate: (sources: MediaSource[]): Promise<MediaItem[]> => ipcRenderer.invoke(MEDIA_IPC.rehydrate, sources),
  saveGeneratedFile: (fileName: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke(MEDIA_IPC.saveGeneratedFile, fileName, data),
  saveStillFrame: (dirPath: string, fileName: string, data: Uint8Array): Promise<string> => ipcRenderer.invoke(MEDIA_IPC.saveStillFrame, { dirPath, fileName, data }),
  getDefaultStillDir: (): Promise<string> => ipcRenderer.invoke(MEDIA_IPC.getDefaultStillDir),
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
  importSrtFile: (): Promise<{ canceled: boolean; fileName?: string; srtText?: string }> =>
    ipcRenderer.invoke(TRANSCRIPTION_IPC.importSrtFile),
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

const vocalRemovalApi = {
  removeVocals: (jobId: string, sourcePath: string, installDir?: string, device?: VoxCpmDevice): Promise<RemoveVocalsResult> =>
    ipcRenderer.invoke(VOCAL_REMOVAL_IPC.removeVocals, { jobId, sourcePath, installDir, device }),
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

const exportApi = {
  pickOutputDir: (): Promise<{ canceled: boolean; path?: string }> => ipcRenderer.invoke(EXPORT_IPC.pickOutputDir),
  getCapabilities: (): Promise<ExportCapabilities> => ipcRenderer.invoke(EXPORT_IPC.getCapabilities),
  startExport: (
    requestId: string,
    sequence: ProjectSequence,
    mediaById: Record<string, { originalPath: string }>,
    aspectRatio: '16:9' | '9:16' | '1:1',
    options: ExportOptions
  ): Promise<void> => ipcRenderer.invoke(EXPORT_IPC.startExport, { requestId, sequence, mediaById, aspectRatio, options }),
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
  /** Runs real VoxCPM2 generation over every voice group in `request`,
   * sequentially. Resolves once every group has been attempted; per-line
   * results stream separately via `onGenerationProgress` as they complete
   * (see that channel's own doc comment in shared/dubbing.ts for why). */
  generateBatch: (request: DubbingGenerationRequest): Promise<void> => ipcRenderer.invoke(DUBBING_IPC.generateBatch, request),
  cancelGeneration: (batchId?: string): Promise<boolean> => ipcRenderer.invoke(DUBBING_IPC.cancelGeneration, batchId),
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
  }
}

const videoStoryNarrationApi = {
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.hasApiKey),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.setApiKey, key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke(VIDEO_STORY_NARRATION_IPC.clearApiKey),
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

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  media: mediaApi,
  transcription: transcriptionApi,
  project: projectApi,
  ai: aiApi,
  localAi: localAiApi,
  story: storyApi,
  export: exportApi,
  windowControls: windowControlsApi,
  updater: updaterApi,
  narration: narrationApi,
  dubbing: dubbingApi,
  videoStoryNarration: videoStoryNarrationApi,
  aiAnimation: aiAnimationApi,
  translation: translationApi,
  vocalRemoval: vocalRemovalApi,
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
