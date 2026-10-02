// Shared transcription / script-alignment / correction-dictionary types
// (Phase C), used by main process, the Python worker's JSON-line protocol,
// preload bridge, and renderer UI.

export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'

export interface ModelOption {
  id: WhisperModelSize
  label: string
  approxSizeMb: number
  description: string
}

export const WHISPER_MODEL_OPTIONS: ModelOption[] = [
  { id: 'tiny', label: 'Tiny', approxSizeMb: 75, description: 'Fastest, lowest accuracy. Good for quick drafts.' },
  { id: 'base', label: 'Base', approxSizeMb: 145, description: 'Fast with modest accuracy.' },
  { id: 'small', label: 'Small', approxSizeMb: 484, description: 'Balanced speed and accuracy. Recommended default.' },
  { id: 'medium', label: 'Medium', approxSizeMb: 1530, description: 'Higher accuracy, slower.' },
  { id: 'large-v3', label: 'Large v3', approxSizeMb: 3100, description: 'Best accuracy, slowest, most memory.' }
]

export type TranscriptionLanguage = 'auto' | 'km' | 'en'

export interface TranscriptWord {
  text: string
  startTime: number
  endTime: number
  confidence: number
}

export interface TranscriptSegment {
  id: string
  words: TranscriptWord[]
  startTime: number
  endTime: number
  language: string
  confidence: number
  /** Text reconstructed from words; the display fallback when editedText is absent. */
  text: string
  /** User override. When present, this is shown instead of `text`; timing is untouched. */
  editedText?: string
  needsReview: boolean
  /** Stable diarization identity for this spoken line. Optional for normal
   * Whisper/imported-SRT transcripts; populated by AI Dubber's speaker pass. */
  speakerId?: string
  /** Gemini heard this line as a character's inner voice -- thought, not
   * said, usually with an echo (see shared/innerVoice.ts). */
  innerVoice?: boolean
  /** Cosine similarity to the assigned speaker centroid (0-1). */
  speakerConfidence?: number
}

export interface Transcript {
  mediaId: string
  segments: TranscriptSegment[]
  requestedLanguage: TranscriptionLanguage
  detectedLanguage?: string
  /** Absent for an SRT-imported transcript (see `source`) -- there's no Whisper run to describe. */
  modelId?: WhisperModelSize
  device?: 'cuda' | 'cpu'
  /** e.g. 'float16' on GPU, 'int8' on CPU. */
  computeType?: string
  generatedAt: string
  audioSourcePath: string
  /** 'srt' for a user-imported subtitle file (Story Narration Workspace); undefined/'whisper'
   * for the normal AI-transcription pipeline. Segments are the same shape either way -- this
   * is purely so UI (e.g. "detected language") can tell the two sources apart. */
  source?: 'whisper' | 'srt' | 'speaker-detection'
}

export type SpeakerGender = 'male' | 'female' | 'unknown'
export type SpeakerAgeCategory = 'child' | 'young' | 'adult' | 'elder' | 'unknown'

/** Persisted character identity inferred from original audio. Embeddings are
 * compact acoustic vectors used for identity continuity, not gender labels. */
export interface DetectedSpeakerProfile {
  id: string
  name: string
  gender: SpeakerGender
  genderConfidence: number
  ageCategory: SpeakerAgeCategory
  ageConfidence: number
  identityConfidence: number
  embedding: number[]
  segmentIds: string[]
}

export interface SpeakerDiarizationObservation {
  segmentId: string
  embedding: number[]
  f0Hz?: number
  voicedRatio: number
  spectralCentroidHz?: number
}

export interface DetectSpeakersRequest {
  jobId: string
  mediaId: string
  originalPath: string
  modelId: WhisperModelSize
  language: TranscriptionLanguage
  /** Only these stretches of the file (seconds) -- Auto SRT's "Fill gaps":
   * the parts of a video that came back with no lines, sent again on their
   * own. Absent: the whole file. */
  ranges?: { start: number; end: number }[]
  /** Where VoxCPM2 is installed, if known: its runtime separates the speech
   * from the music before Gemini hears it. Searched for when absent. */
  voxCpmInstallDir?: string
}

export interface DetectSpeakersResult {
  transcript: Transcript
  speakers: DetectedSpeakerProfile[]
  srtText: string
  srtPath: string
  srtFileName: string
  /** Seconds of audio Gemini could not transcribe cleanly (music, noise,
   * overlapping shouting) -- where lines may be missing. */
  unclearSeconds?: number
}

export interface DetectSpeakersProgress {
  jobId: string
  stage: 'extracting-audio' | 'transcribing' | 'embedding' | 'clustering' | 'writing-srt' | 'ready' | 'error' | 'canceled'
  percent: number
  message: string
}

export interface ScriptAlignmentSegment {
  text: string
  startTime: number
  endTime: number
  matchedWordCount: number
  confidence: number
}

export interface ScriptAlignment {
  mediaId: string
  scriptText: string
  segments: ScriptAlignmentSegment[]
  generatedAt: string
}

export type TranscriptionStage =
  | 'queued'
  | 'preparing-audio'
  | 'loading-model'
  | 'downloading-model'
  | 'transcribing'
  | 'paused'
  | 'ready'
  | 'error'
  | 'canceled'

export interface TranscriptionProgressUpdate {
  mediaId: string
  stage: TranscriptionStage
  percent: number
  message?: string
  errorMessage?: string
  transcript?: Transcript
}

export interface DeviceInfo {
  device: 'cuda' | 'cpu'
  cudaAvailable: boolean
  cudaDeviceName?: string
  driverVersion?: string
  /** Whether the pip-installed nvidia-cublas-cu12 / nvidia-cudnn-cu12 DLLs were found. */
  gpuLibsFound?: boolean
  cublasVersion?: string
  cudnnVersion?: string
  ctranslate2Version?: string
  /** Set once a real (not just device-count) inference test has succeeded. */
  verified?: boolean
  computeType?: string
  reason?: string
}

export interface GpuVerificationResult {
  ok: boolean
  loadTimeSeconds?: number
  inferenceTimeSeconds?: number
  computeType?: string
  error?: string
}

export interface ModelStatus extends ModelOption {
  downloaded: boolean
}

export interface ModelDownloadProgress {
  modelId: WhisperModelSize
  stage: 'downloading' | 'verifying' | 'ready' | 'error' | 'canceled'
  percent: number
  bytesDownloaded?: number
  totalBytes?: number
  errorMessage?: string
}

export type CorrectionCategory = 'person' | 'place' | 'company' | 'technical' | 'spelling' | 'capitalization' | 'other'

export interface CorrectionDictionaryEntry {
  id: string
  original: string
  correction: string
  category: CorrectionCategory
  language: 'km' | 'en' | 'mixed'
  enabled: boolean
  createdAt: string
  timesApplied: number
}

export interface CorrectionMatch {
  entryId: string
  segmentId: string
  original: string
  correction: string
  /** Character offset of the match within the segment's current display text. */
  index: number
}

export const TRANSCRIPTION_IPC = {
  getDeviceInfo: 'transcription:getDeviceInfo',
  retryGpuDetection: 'transcription:retryGpuDetection',
  verifyGpu: 'transcription:verifyGpu',
  listModels: 'transcription:listModels',
  downloadModel: 'transcription:downloadModel',
  cancelModelDownload: 'transcription:cancelModelDownload',
  modelDownloadProgress: 'transcription:modelDownloadProgress',
  start: 'transcription:start',
  pause: 'transcription:pause',
  resume: 'transcription:resume',
  cancel: 'transcription:cancel',
  retry: 'transcription:retry',
  progress: 'transcription:progress',
  alignScript: 'transcription:alignScript',
  getCorrectionDictionary: 'transcription:getCorrectionDictionary',
  addCorrectionEntry: 'transcription:addCorrectionEntry',
  updateCorrectionEntry: 'transcription:updateCorrectionEntry',
  removeCorrectionEntry: 'transcription:removeCorrectionEntry',
  importCorrectionDictionary: 'transcription:importCorrectionDictionary',
  exportCorrectionDictionary: 'transcription:exportCorrectionDictionary',
  exportCorrectionDictionaryToFile: 'transcription:exportCorrectionDictionaryToFile',
  importCorrectionDictionaryFromFile: 'transcription:importCorrectionDictionaryFromFile',
  workerStatus: 'transcription:workerStatus',
  importSrtFile: 'transcription:importSrtFile',
  detectSpeakers: 'transcription:detectSpeakers',
  cancelDetectSpeakers: 'transcription:cancelDetectSpeakers',
  detectSpeakersProgress: 'transcription:detectSpeakersProgress'
} as const
