/**
 * AI Editing — the data the "Learn My Editing Style" feature records and learns
 * from. These are plain, serialisable shapes shared by the main process
 * (analysis + storage), the Python analysis runner (via JSON), and the
 * renderer (Training workspace UI). No behaviour lives here, only the schema.
 *
 * The flow, in one sentence: each ORIGINAL + EDITED video pair is reverse-
 * analysed into a list of matched segments (which part of the source footage
 * became which part of the final cut), those matches are joined with the
 * edited video's Khmer narration, and the result is a list of `EditSample`s —
 * the examples a model (later) learns the user's pacing and scene choices from.
 *
 * Everything is versioned so a dataset made by an older build still loads.
 */

export const AI_EDITING_SCHEMA_VERSION = 1

/** Seconds from the start of a video. */
export type Seconds = number

/** 0..1, how sure the analysis is about a match or a boundary. */
export type Confidence = number

/**
 * One shot of a video: a continuous run of frames between two cuts. Produced
 * by scene/shot-boundary detection on BOTH the original and the edited video.
 */
export interface Shot {
  index: number
  start: Seconds
  end: Seconds
  /** end - start, carried for convenience (the model predicts this). */
  duration: Seconds
  /** 64-bit perceptual hash (pHash) of a representative frame, as hex, for a
   * fast first-pass match before the heavier embedding compare. */
  pHash?: string
  /** A visual embedding (e.g. CLIP image features) of a representative frame,
   * for semantic similarity. Stored separately when large; see
   * `embeddingRef`. Inline only for small/preview datasets. */
  embedding?: number[]
  /** Points into an embeddings side-file instead of inlining the vector:
   * `{ file, row }`. Large datasets keep vectors out of the main JSON. */
  embeddingRef?: { file: string; row: number }
  /** A thumbnail path (cached under the project) for the UI to show. */
  thumbnail?: string
}

/** How a source shot was transformed on its way into the edit. All optional —
 * absence means "not detected / unchanged". These are observations, not
 * guarantees, and the UI presents them as such. */
export interface ShotTransform {
  /** Edited playbackRate inferred from matched-segment durations (1 = same). */
  speed?: number
  /** The source was cropped/zoomed (framing changed) before use. */
  cropped?: boolean
  /** The source was resized to a different resolution/aspect. */
  resized?: boolean
  /** An overlay (text, logo, PiP) sits on top in the edit. */
  overlay?: boolean
}

/**
 * One matched segment: a slice of the ORIGINAL footage that the analysis
 * believes became a slice of the EDITED video. This is the core "reverse
 * editing" output.
 */
export interface SegmentMatch {
  id: string
  /** Where it sits in the final cut. */
  editedStart: Seconds
  editedEnd: Seconds
  /** Where it came from in the source footage. */
  sourceStart: Seconds
  sourceEnd: Seconds
  confidence: Confidence
  transform?: ShotTransform
  /** The source shot index this match belongs to, when known. */
  sourceShot?: number
  /** The edited shot index this match fills, when known. */
  editedShot?: number
  /** Set true once a human has checked or fixed this match in the UI. Human
   * edits are trusted over the detector and are weighted up in training. */
  reviewed?: boolean
  /** 'auto' = detector, 'manual' = user drew/corrected it. */
  origin: 'auto' | 'manual'
}

/** A stretch of the edited narration: one spoken line/sentence with its time
 * and text. From the edited video's audio (vocals separated when it has music)
 * or a separate narration file, via the existing Khmer transcription. */
export interface NarrationSegment {
  id: string
  start: Seconds
  end: Seconds
  text: string
  /** True when the time came from a detected pause boundary rather than the
   * recogniser's own word timing (less precise). */
  fromSilence?: boolean
  /** Lowered when the recogniser was unsure; the UI flags these for review. */
  confidence?: Confidence
  /** Set once a human has corrected the text or timing. */
  reviewed?: boolean
}

/**
 * One training example. Joins a narration segment to the editing decision the
 * user made over it: which source scene they chose, how long they held it,
 * where they cut. This is what a model reads to imitate the style.
 */
export interface EditSample {
  id: string
  pairId: string
  /** Absent until the edited video's Khmer narration has been transcribed;
   * samples are still useful shot-by-shot before then. */
  narration?: NarrationSegment
  /** The matched source segment(s) shown during this narration. Usually one,
   * but a line can span several quick cuts. */
  segments: SegmentMatch[]
  /** editedEnd - editedStart of the covered span (what the model predicts for
   * "how long to hold a scene over this narration"). */
  editedDuration: Seconds
  /** Number of cuts within this narration span — the pacing signal. */
  cutCount: number
  /** A short scene description (optional, from a caption model later). */
  sceneDescription?: string
  /** Lowest match confidence among `segments`, for filtering/weighting. */
  confidence: Confidence
}

/** A single original→edited example in a training project. */
export interface EditPair {
  id: string
  name: string
  originalMediaPath: string
  editedMediaPath: string
  /** Optional separate clean narration audio; when absent the edited video's
   * own (vocal-separated) audio is used. */
  narrationAudioPath?: string
  /** Optional Khmer SRT/script to align against the transcription. */
  scriptPath?: string
  addedAt: number
  /** Where the pair is in the pipeline. */
  status: 'new' | 'analyzing' | 'analyzed' | 'needs-review' | 'ready' | 'error'
  /** Last analysis error, when status is 'error'. */
  error?: string
  /** Progress 0..1 while analyzing. */
  progress?: number
  /** Filled by analysis. */
  sourceShots?: Shot[]
  editedShots?: Shot[]
  matches?: SegmentMatch[]
  narration?: NarrationSegment[]
  samples?: EditSample[]
  /** Durations, so the UI/model don't reopen the files. */
  originalDuration?: Seconds
  editedDuration?: Seconds
}

/** A folder of pairs the user is teaching the AI from. Several can exist (e.g.
 * different show styles). Stored as JSON in userData; large vectors/thumbs go
 * in a per-project folder beside it, never duplicating the source videos. */
export interface TrainingProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  pairs: EditPair[]
  /** Ids of models trained from this project (see EditStyleModel). */
  modelIds: string[]
  /** Free-form notes the user keeps about this style. */
  notes?: string
}

/** Aggregate numbers the UI shows for a project without walking every sample. */
export interface TrainingProjectSummary {
  id: string
  name: string
  pairCount: number
  analyzedCount: number
  sampleCount: number
  updatedAt: number
}

/** A learned (or baseline) editing style. v1 ships the baseline — similarity
 * search + rules — so the field set already carries what a trained model adds
 * later (ranking/duration/cut heads) without another schema change. */
export interface EditStyleModel {
  id: string
  name: string
  projectId: string
  createdAt: number
  /** 'baseline' = no training, similarity + rules. 'trained' = a fitted model
   * checkpoint exists at `checkpointPath`. */
  kind: 'baseline' | 'trained'
  checkpointPath?: string
  /** How the model was evaluated — never presented as accurate without this. */
  metrics?: EditStyleMetrics
  /** Style defaults distilled from the dataset (used even by the baseline):
   * median scene hold, cuts per spoken minute, etc. */
  style?: LearnedStyle
}

/** Honest evaluation, split by whole pair (never by random clip — that would
 * leak). Absent until an evaluation has actually run. */
export interface EditStyleMetrics {
  evaluatedAt: number
  /** How many pairs were held out for the eval. */
  heldOutPairs: number
  /** Top-k scene-selection accuracy against the held-out edits. */
  sceneSelectionAccuracy?: number
  /** Median absolute error of predicted vs actual clip duration, seconds. */
  durationMae?: Seconds
  /** Median absolute cut-position error, seconds. */
  cutTimingMae?: Seconds
  /** Share of AI picks the user kept unchanged in real use (filled over time
   * by continuous learning). */
  keptRate?: number
}

/** Plain, interpretable numbers the baseline editor follows and the UI can show. */
export interface LearnedStyle {
  /** Typical time a scene is held, seconds. */
  medianHold: Seconds
  /** Cuts per minute of narration. */
  cutsPerMinute: number
  /** How often a new scene starts exactly on a new narration line (0..1). */
  cutOnNarration: number
  /** Preferred speed multipliers seen in the edits. */
  commonSpeeds: number[]
}

/** The raw JSON `edit_analysis_runner.py` writes (before it is folded into an
 * EditPair). Kept separate so the runner's shape and the stored shape can
 * evolve independently. */
export interface RawAnalysisResult {
  method: string
  fps: number
  originalDuration: Seconds
  editedDuration: Seconds
  sourceShots: Array<Pick<Shot, 'index' | 'start' | 'end' | 'duration'>>
  editedShots: Array<Pick<Shot, 'index' | 'start' | 'end' | 'duration'>>
  matches: Array<Omit<SegmentMatch, 'id'>>
}

/** A stable progress-routing id for the auto-edit job (it has no pair id, so
 * the renderer matches its progress on this constant). */
export const AUTO_EDIT_JOB = '__auto_edit__'

/** Progress for a running analysis, sent to the renderer. */
export interface AiEditProgress {
  pairId: string
  phase: 'decoding' | 'detecting' | 'matching' | 'narration' | 'samples' | 'done'
  percent: number
  message?: string
}

/** Every AI-editing IPC call returns this: data on success, a message (and a
 * `canceled` flag for stopped analyses) on failure. */
export type AiEditResult<T> = { ok: true; data: T } | { ok: false; error: string; canceled?: boolean }

/** IPC channel names for the AI Editing feature. */
export const AI_EDIT_IPC = {
  listProjects: 'ai-edit:list-projects',
  createProject: 'ai-edit:create-project',
  getProject: 'ai-edit:get-project',
  deleteProject: 'ai-edit:delete-project',
  renameProject: 'ai-edit:rename-project',
  pickVideo: 'ai-edit:pick-video',
  pickVideos: 'ai-edit:pick-videos',
  pickVideoFolder: 'ai-edit:pick-video-folder',
  addPair: 'ai-edit:add-pair',
  addPairs: 'ai-edit:add-pairs',
  removePair: 'ai-edit:remove-pair',
  analyzePair: 'ai-edit:analyze-pair',
  transcribeNarration: 'ai-edit:transcribe-narration',
  autoEdit: 'ai-edit:auto-edit',
  cancelAnalyze: 'ai-edit:cancel-analyze',
  progress: 'ai-edit:progress',
} as const

/** A flagged copyright RISK (never a verdict). Shown as review, not a block. */
export interface CopyrightRisk {
  kind: 'long-original-run' | 'original-audio' | 'repeated-source' | 'low-transformation'
  editedStart: Seconds
  editedEnd: Seconds
  /** Why it was flagged, in plain words for the user. */
  note: string
  /** How strongly it was flagged (not a probability of infringement). */
  severity: 'info' | 'warn'
}
