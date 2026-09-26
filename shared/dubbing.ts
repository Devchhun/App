// AI Dubber -- shared types, defaults and IPC channel names for the
// subtitle-to-synthesized-voice workflow (VoxCPM2 / Edge TTS). The
// renderer's AiDubberContext owns the live state; the main process
// (app/main/ipc/dubbing.ts) runs the engines.
//
// (Reconstructed from the compiled 0.1.5 bundle and every consumer after
// the source file was lost to a failed write -- runtime values are exact,
// types follow their use sites.)

import type { NarrationSpeaker } from './narration'
import type { DetectedSpeakerProfile, SpeakerAgeCategory, SpeakerGender } from './transcription'

export type { NarrationSpeaker }

/** Where the VoxCPM2 model runs ('auto' lets the runtime pick CUDA when
 * it is usable, CPU otherwise). */
export type VoxCpmDevice = 'auto' | 'cpu' | 'cuda'

/** Which engine speaks the lines: the local VoxCPM2 model (any voice,
 * cloning) or Microsoft Edge neural TTS (fixed catalog, needs internet). */
export type DubbingEngine = 'voxcpm2' | 'edge-tts'

export interface ValidateVoxCpmInstallResult {
  ok: boolean
  /** Required paths that are missing (empty when ok). */
  missing: string[]
}

/** How well a Custom Voice reference clip will clone -- measured by the
 * runtime's own speaker encoder (python-worker/voice_clip_quality.py). */
export interface ReferenceClipQuality {
  /** Mean speaker-embedding similarity across the clip's windows: how
   * steadily it holds ONE voice. */
  consistency: number
  /** Share of samples at/near full scale. */
  clippedRatio: number
  /** Share of the clip that is speech rather than silence. */
  speechRatio: number
}

/** Thresholds come from measured clips in a real project: the 0.87 clip
 * cloned every line at 0.83-0.93, the 0.78 clip never got above ~0.79. */
export function referenceClipVerdict(quality: ReferenceClipQuality): 'good' | 'fair' | 'weak' {
  if (quality.consistency < 0.8 || quality.clippedRatio > 2e-3 || quality.speechRatio < 0.5) return 'weak'
  if (quality.consistency < 0.84) return 'fair'
  return 'good'
}

export type PrepareReferenceClipResult =
  | { ok: true; outputPath: string; durationSeconds: number; quality?: ReferenceClipQuality }
  | { ok: false; error: string }

export type RefitClipAudioResult = { ok: true; outputPath: string } | { ok: false; error: string }

export type DubbingSegmentStatus = 'pending' | 'voice-assigned' | 'generating' | 'generated' | 'needs-review'

/** Per-subtitle bookkeeping for the AI Dubber workspace. */
export interface DubbingSegmentState {
  segmentId: string
  speakerId?: string
  /** Estimated from the ORIGINAL video's own audio (pitch heuristic). */
  detectedGender: NarrationSpeaker
  detectedConfidence?: number
  /** Catalog voice id, 'custom-voice', or a saved voice (`saved:<id>`). */
  voiceId?: string
  /** True once the user picked `voiceId` themselves (a card, a review
   * dropdown, a saved recording) -- gender detection then never swaps it. */
  voiceManuallyAssigned?: boolean
  ageGroup?: 'child' | 'young' | 'adult' | 'old' | 'elder' | 'unknown'
  isNarrator?: boolean
  /** Semitones -- applied as ffmpeg post-processing after generation. */
  pitch: number
  /** Playback-rate multiplier, composed with the automatic slot-fit speed. */
  speed: number
  volumeDb: number
  status: DubbingSegmentStatus
  /** The generated clip currently on the DUB track for this line. */
  generatedClipId?: string
  /** Set when this line was read inside a neighbouring line's take (same
   * voice, close together -- see renderer dubbingPlan.ts): the id of that
   * take's first line. The line then shares that line's clip. */
  joinedInto?: string
}

export interface DubbingSpeakerProfile extends DetectedSpeakerProfile {
  gender: SpeakerGender
  ageCategory: SpeakerAgeCategory
  genderManualOverride?: boolean
  ageManualOverride?: boolean
  /** Assigning this once applies it to every subtitle carrying speakerId. */
  voiceId?: string
  voiceManuallyAssigned?: boolean
  mergedFrom?: string[]
}

export interface DubbingWorkspaceState {
  active: boolean
  videoMediaId?: string
  srtFileName?: string
  genderDetectionStatus: 'idle' | 'detecting' | 'detected'
  segments: Record<string, DubbingSegmentState>
  /** Character-level identity and voice settings, persisted with project. */
  speakers: Record<string, DubbingSpeakerProfile>
  generatedSrtPath?: string
  generationProgress?: { completed: number; total: number }
  /** First real reason a run failed (later segments usually repeat it). */
  generationError?: string
  /** Something worth knowing about the last run that is not a failure --
   * e.g. lines skipped because they had no words to speak. */
  generationNote?: string
  /** Custom Voice card: the prepared (mono 16-bit wav) reference clip. */
  customVoiceReferenceAudioPath?: string
  /** Optional note about what that clip says -- never sent to the model. */
  customVoiceReferenceText?: string
}

/** The workspace as it should be saved to (and loaded from) a project: the
 * last run's messages and progress belong to that run, not to the project.
 * Saving them made an old error -- e.g. an Edge TTS traceback from before a
 * fix -- reappear every time the project was opened, with no way to clear
 * it. A line left 'generating' by a project closed mid-run goes back to
 * where it was before that run. */
export function withoutTransientDubbingState(state: DubbingWorkspaceState): DubbingWorkspaceState {
  const segments: DubbingWorkspaceState['segments'] = {}
  for (const [id, line] of Object.entries(state.segments ?? {})) {
    segments[id] = line.status === 'generating' ? { ...line, status: line.voiceId ? 'voice-assigned' : 'pending', joinedInto: undefined } : line
  }
  const { generationError: _error, generationNote: _note, generationProgress: _progress, ...rest } = state
  return { ...rest, segments }
}

export function createDefaultDubbingWorkspaceState(): DubbingWorkspaceState {
  return { active: false, genderDetectionStatus: 'idle', segments: {}, speakers: {} }
}

export function defaultDubbingSegmentState(segmentId: string): DubbingSegmentState {
  return { segmentId, detectedGender: 'unknown', pitch: 0, speed: 1, volumeDb: 0, status: 'pending' }
}

export const DUBBING_IPC = {
  /** Extracts [startTime, endTime) of `sourcePath`'s own audio to a new
   * saved file -- the ORIGINAL "Generate Dubbing" placeholder clip (the
   * subtitle line's own audio, not a synthesized voice). Kept, unused by
   * default, as a graceful fallback for whenever VoxCPM2 isn't installed/
   * validated -- see app/main/media/dubbingAudio.ts. */
  extractPlaceholderClip: 'dubbing:extractPlaceholderClip',
  /** Checks that a VoxCPM2 portable install directory actually has every
   * required file/folder (python runtime, model weights, source package) --
   * see app/main/media/voxcpmTts.ts's validateVoxCpmInstall, which mirrors
   * the portable GUI's own `_validate_install()` exactly. */
  validateInstall: 'dubbing:validateInstall',
  /** Finds portable VoxCPM2 installs on this machine without the user
   * typing a path -- see app/main/media/voxcpmDiscovery.ts. Returns every
   * valid install in search order, best guess first, so the app can
   * configure itself on a computer it has never run on. */
  detectInstalls: 'dubbing:detectInstalls',
  /** Native folder picker for the install path ("Browse..."). */
  pickInstallFolder: 'dubbing:pickInstallFolder',
  /** Runs one or more VoxCPM2 `batch` CLI invocations (one per voice group)
   * over real subtitle text -- see app/main/media/voxcpmTts.ts. Resolves
   * once every group has finished (success or failure per line); per-line
   * results stream separately via `generationProgress` as they complete,
   * not bundled into this call's own return value, so the renderer never
   * has to wait for the whole batch before showing anything. */
  generateBatch: 'dubbing:generateBatch',
  /** Joins generated line files into one continuous WAV (Recap narration)
   * -- see app/main/media/audioStitch.ts. */
  stitchAudio: 'dubbing:stitchAudio',
  /** Main -> renderer push (ipcRenderer.on, not invoke/handle) -- one event
   * per subtitle line as VoxCPM2 finishes or fails it, fired throughout a
   * generateBatch call. Mirrors MEDIA_IPC.progress's exact push pattern. */
  generationProgress: 'dubbing:generationProgress',
  /** Re-renders one already-generated line at a new speed, for AI Dubber's
   * Auto-Speed pass (see app/main/media/voxcpmTts.ts's applyDubbingPostFx).
   * Separate from generateBatch because nothing is being synthesized here --
   * the voice already exists, only its tempo changes. */
  refitClipAudio: 'dubbing:refitClipAudio',
  /** Converts a recording (or any audio file the user picked) into the mono
   * 16-bit wav VoxCPM2 can actually read as a Custom Voice cloning
   * reference -- see app/main/media/voxcpmTts.ts's prepareReferenceClip. */
  prepareReferenceClip: 'dubbing:prepareReferenceClip',
  /** Stops a running generateBatch: no new line starts, and the voice
   * process working on the current one is killed. Lines already finished
   * are kept. Takes the batch's `batchId`, or nothing for AI Dubber's own
   * untagged batch. */
  cancelGeneration: 'dubbing:cancelGeneration'
} as const

export interface DubbingGenerationGroupSegment {
  segmentId: string
  text: string
  /** This subtitle's own time range -- lets the main process compute how
   * much a generated line overruns its slot (see
   * app/main/media/voxcpmTts.ts's computeAutoFitSpeed) without a second
   * round-trip back to the renderer for it. Never used to place the clip
   * itself -- sequenceOps.acceptDubbingClip still does that from the
   * renderer's own segment lookup, same as before. */
  startTime: number
  endTime: number
  /** The start time of whichever subtitle comes right after this one in the
   * WHOLE video's own chronological order -- regardless of which voice
   * group either one belongs to (segments are split by voice for batching,
   * so the main process can't derive "what's next" from its own group
   * alone). Undefined only for the very last subtitle in the video. Used to
   * cap this line's own generated audio so it can never audibly overlap the
   * next character's line, even though multiple DUB tracks (DUB1, DUB2, ...)
   * all mix together in the final render regardless of which one either
   * clip lands on -- see app/main/ipc/dubbing.ts's handleSegmentDone. */
  nextSegmentStartTime?: number
  /** Semitones -- applied as ffmpeg post-processing after VoxCPM2 generates
   * the line, since none of these three are native VoxCPM2 generation
   * params (see app/main/media/voxcpmTts.ts's applyDubbingPostFx). */
  pitch: number
  /** Playback-rate multiplier -- composed with the automatic slot-fit speed
   * (never past voxcpmTts's ceiling). */
  speed: number
  volumeDb: number
}

export interface DubbingGenerationGroup {
  voiceId: string
  /** Free-text VoxCPM2 voice-design instruction for every segment in this
   * group -- omitted for a reference-audio clone group (see
   * `referenceAudioPath`/`promptText` below), never both. */
  control?: string
  /** Reference-audio voice cloning (the "Custom Voice" card) instead of a
   * `control` description -- both required together or neither. */
  referenceAudioPath?: string
  promptText?: string
  /** The Edge TTS voice name for this group (e.g. 'km-KH-PisethNeural'),
   * used only when the request's engine is 'edge-tts'. Unset for a voice
   * the Edge catalog has no equivalent of -- those groups are reported as
   * failed rather than silently swapped for a different voice. */
  edgeVoice?: string
  segments: DubbingGenerationGroupSegment[]
}

/** How hard VoxCPM2 is pushed to obey its conditioning. Higher holds one
 * speaker more tightly; lower sounds smoother and less "processed". The
 * numbers behind each are in app/main/media/voxcpmTts.ts. */
export type VoiceTone = 'natural' | 'balanced' | 'locked'

export const DEFAULT_VOICE_TONE: VoiceTone = 'balanced'

export interface DubbingGenerationRequest {
  engine: DubbingEngine
  /** Defaults to 'balanced' when absent (older callers). */
  tone?: VoiceTone
  installDir: string
  device: VoxCpmDevice
  groups: DubbingGenerationGroup[]
  /** Pitch match on cloned groups (default on when absent) -- see
   * app/main/media/voxcpmTts.ts's buildSeededBatchArgs. */
  pitchMatch?: boolean
  /** Who this batch belongs to. The AI Dubber sends none; the Recap
   * narration tags its own so each side handles only its own results
   * off the shared `generationProgress` channel. */
  batchId?: string
}

export interface DubbingGenerationProgressEvent {
  segmentId: string
  status: 'generated' | 'failed'
  outputPath?: string
  error?: string
  /** Echo of the request's `batchId` (absent for an untagged batch). */
  batchId?: string
}
