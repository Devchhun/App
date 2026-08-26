import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { MEDIA_IPC } from '@shared/media'
import type { FfmpegAvailability, MediaItem, MediaProgressUpdate } from '@shared/media'
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
  CorrectionCategory
} from '@shared/transcription'
import { PROJECT_IPC } from '@shared/project'
import type { ProjectFile, MediaSource, ProjectSequence } from '@shared/project'
import type { ProvisionProgress } from '../main/ai/provisionVenv'
import { AI_IPC } from '@shared/suggestions'
import type { AiSuggestion, CloudRequestPreview, GenerateSuggestionsResult, GenerateSuggestionsError } from '@shared/suggestions'
import { LOCAL_AI_IPC } from '@shared/localAi'
import type { LocalAiHealth, LocalModelInfo, ModelPullProgress, GenerateScenePlanResult, LocalAiError, ScenePlanGenerationOptions } from '@shared/localAi'
import { STORY_IPC } from '@shared/story'
import type { GenerateNarrativeGraphResult, StoryAnalysisError } from '@shared/story'
import { EXPORT_IPC } from '@shared/export'
import type { ExportOptions, ExportProgress, ExportCapabilities } from '@shared/export'
import { WINDOW_IPC } from '@shared/window'
import { UPDATER_IPC } from '@shared/updater'
import type { UpdaterStatus } from '@shared/updater'

const mediaApi = {
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(MEDIA_IPC.pickFiles),
  importPaths: (paths: string[]): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.importPaths, paths),
  cancelJob: (mediaId: string): Promise<boolean> => ipcRenderer.invoke(MEDIA_IPC.cancelJob, mediaId),
  retryJob: (mediaId: string): Promise<void> => ipcRenderer.invoke(MEDIA_IPC.retryJob, mediaId),
  getFfmpegStatus: (): Promise<FfmpegAvailability> => ipcRenderer.invoke(MEDIA_IPC.ffmpegStatus),
  rehydrate: (sources: MediaSource[]): Promise<MediaItem[]> => ipcRenderer.invoke(MEDIA_IPC.rehydrate, sources),
  saveGeneratedFile: (fileName: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke(MEDIA_IPC.saveGeneratedFile, fileName, data),
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
  onWorkerStatus: (callback: (p: ProvisionProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: ProvisionProgress): void => callback(p)
    ipcRenderer.on(TRANSCRIPTION_IPC.workerStatus, listener)
    return () => ipcRenderer.removeListener(TRANSCRIPTION_IPC.workerStatus, listener)
  }
}

const projectApi = {
  getOrCreateStartup: (): Promise<ProjectFile> => ipcRenderer.invoke(PROJECT_IPC.getOrCreateStartup),
  save: (project: ProjectFile): Promise<string> => ipcRenderer.invoke(PROJECT_IPC.save, project)
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
    ipcRenderer.invoke(AI_IPC.simplifySuggestion, { requestId, text })
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
  updater: updaterApi
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
