// Story Narration Workspace's persisted state shape (shared/project.ts's
// ProjectFile.narrationWorkspace, schemaVersion 8). Deliberately does NOT
// duplicate segment text/timing -- that already lives in TranscriptSegment
// (shared/transcription.ts), reached via `transcripts[videoMediaId]`. This
// is purely the workspace's own orchestration/progress state: which video
// and SRT are active, and per-segment recording/speaker/take bookkeeping.

export type NarrationRecordingStatus = 'pending' | 'recording' | 'recorded' | 'accepted' | 'needs-review'

export type NarrationSpeaker = 'male' | 'female' | 'unknown'

/** One recorded attempt at a segment -- `mediaId` is a real MediaItem id
 * (the take is always a genuine imported/saved audio asset, never a
 * dangling object-URL-only reference), so takes persist with the project. */
export interface NarrationTake {
  id: string
  mediaId: string
  createdAt: string
  durationSeconds: number
}

export interface NarrationSegmentState {
  segmentId: string
  status: NarrationRecordingStatus
  speaker: NarrationSpeaker
  /** 0-1, present only when `speaker` was set by the pitch-heuristic
   * detector, never for a manual override. */
  speakerConfidence?: number
  speakerManualOverride?: boolean
  takes: NarrationTake[]
  acceptedTakeId?: string
  /** The TimelineClip id currently on VO1 for this segment, if any -- see
   * sequenceOps.acceptNarrationTake. Kept here (not derived) so "replace my
   * previous accepted take" always knows exactly which clip to remove. */
  acceptedClipId?: string
}

/** Every optimization step is optional and non-destructive to pitch/timing
 * (see app/main/media/narrationAudio.ts) -- trim/fade default on since they
 * only ever remove silence the user didn't intend to keep; the others
 * default off so a first-time user hears exactly what they recorded unless
 * they opt in. */
export interface NarrationOptimizationSettings {
  trimSilence: boolean
  fadeInOut: boolean
  noiseReduction: boolean
  loudnessNormalize: boolean
  autoGain: boolean
}

export function createDefaultNarrationOptimizationSettings(): NarrationOptimizationSettings {
  return { trimSilence: true, fadeInOut: true, noiseReduction: false, loudnessNormalize: false, autoGain: false }
}

export interface NarrationWorkspaceState {
  active: boolean
  videoMediaId?: string
  srtFileName?: string
  currentSegmentId?: string
  microphoneDeviceId?: string
  optimization: NarrationOptimizationSettings
  /** Keyed by TranscriptSegment.id. A segment with no entry here is treated
   * as 'pending' with speaker 'unknown' and no takes -- entries are created
   * lazily as the user interacts with each segment, not pre-populated for
   * the whole SRT on import. */
  segments: Record<string, NarrationSegmentState>
}

export function createDefaultNarrationWorkspaceState(): NarrationWorkspaceState {
  return { active: false, optimization: createDefaultNarrationOptimizationSettings(), segments: {} }
}

export function defaultNarrationSegmentState(segmentId: string): NarrationSegmentState {
  return { segmentId, status: 'pending', speaker: 'unknown', takes: [] }
}

export const NARRATION_IPC = {
  /** Estimates Male/Female from the ORIGINAL video's own audio over one
   * segment's time range (autocorrelation pitch heuristic) -- never from the
   * subtitle text. See app/main/media/speakerDetect.ts. */
  detectSpeaker: 'narration:detectSpeaker',
  /** Applies the enabled NarrationOptimizationSettings to a just-recorded
   * take, in place (temp-file-then-rename). Never alters pitch/speed/words --
   * see app/main/media/narrationAudio.ts. */
  optimizeTake: 'narration:optimizeTake'
} as const

export interface DetectSpeakerResult {
  speaker: NarrationSpeaker
  /** 0-1; omitted (not zero) when the signal was too weak/ambiguous to
   * estimate at all -- `speaker` is 'unknown' in that case. */
  confidence?: number
}
