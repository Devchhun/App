import { kiriVoiceId, kiriVoiceOf } from '@shared/kiriTts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DetectSpeakersResult, SpeakerAgeCategory, SpeakerGender, TranscriptSegment, Transcript } from '@shared/transcription'
import type { MediaItem } from '@shared/media'
import { createEmptySequence, type ProjectSequence, type TimelineClip } from '@shared/project'
import { parseSrtToSegments, transcriptSegmentsToSrt } from '@shared/srt'
import { restoreDubbingWorkspace, splitDubbingSrt } from '@shared/dubbingSrt'
import {
  createDefaultDubbingWorkspaceState,
  defaultDubbingSegmentState,
  withoutTransientDubbingState,
  type DubbingWorkspaceState,
  type DubbingSegmentState,
  type DubbingEpisode,
  type DubbingEpisodeWorkspace,
  type DubbingSpeakerProfile,
  type NarrationSpeaker
} from '@shared/dubbing'
import {
  compareEpisodeNames,
  episodeSrtFileName,
  episodesToTranscribe,
  episodeWorkspaceOf,
  isSeriesWideFailure,
  withEpisodeOpen,
  withEpisodesAdded
} from '@shared/dubbingEpisodes'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useSequence } from '../sequence/SequenceContext'
import { usePlaybackTime, usePlaybackControls } from '../playback/PlaybackContext'
import { useHistory } from '../history/HistoryContext'
import { useUiState, type LeftView, type RightTab } from '../nav/UiStateContext'
import { DUBBING_TRACK_ID, findOrCreateTrack, getMainVideoTrackId, type OccupiedRange } from '../timeline/trackModel'
import { ECHO_SCORE_THRESHOLD, effectiveInnerVoice, innerVoiceFromText } from '@shared/innerVoice'
import { batchPartsOf, findGaps, lineSource, mergeGapLines, mergePartSegments, pairSrtsWithVideos, partLocalSegments, placePartTranscript, type BatchPart, type SubtitleGap } from '@shared/dubbingBatch'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { findSavedVoice, isSavedVoiceId, loadSavedVoices, loadStoryNarratorVoiceId } from './savedVoices'
import { VOICE_MODELS, recommendVoiceId, edgeFallbackVoiceId } from './voiceModels'
import { cleanTextForSpeech, hasSpeakableText } from './ttsTextCleaning'
import { unreadableScriptFor } from '@shared/ttsLanguage'
import { autoSpeedFor, planAutoSync, planGenerationUnits, resolveLineVoice, KIRI_FALLBACK_FEMALE, KIRI_FALLBACK_MALE, type GenerationUnit, type PlannedLine } from './dubbingPlan'
import { applyVideoSync, planVideoSync, retimeSegmentsForVideoSync, videoSyncAddedSeconds } from './videoSync'
import { clipRate } from '@shared/clipTiming'
import { sanitizeVideoOverlaySettings, type OverlayLine, type VideoOverlaySettings } from '@shared/videoOverlay'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey, type DubbingEngine } from './voxcpmSettings'
import { kiriCopyOf } from './useKiriVoices'
import type { DubbingGenerationGroup } from '@shared/dubbing'
import {
  CONTEXT_WINDOW_LINES,
  analyzePerformancesByRules,
  neutralPerformance,
  sanitizePerformance,
  type LinePerformance,
  type PerformanceInputLine
} from '@shared/dubbingPerformance'

export interface PrepareDubbingResult {
  segmentCount: number
  warnings: string[]
}

/** Where Add SRT put each picked SRT. */
export interface SrtPlacement {
  placed: { srt: string; video: string; lines: number }[]
  unmatched: string[]
}

/** "3 SRTs added: EP1.srt -> EP1.mp4 (120 lines), …" */
export function srtPlacementMessage(result: SrtPlacement): string {
  const parts: string[] = []
  if (result.placed.length > 0) parts.push(`${result.placed.length} SRT${result.placed.length === 1 ? '' : 's'} added: ${result.placed.map((p) => `${p.srt} → ${p.video} (${p.lines} lines)`).join(', ')}.`)
  if (result.unmatched.length > 0) parts.push(`No video on the Timeline for ${result.unmatched.join(', ')}.`)
  return parts.join(' ')
}

export interface AiDubberContextValue {
  state: DubbingWorkspaceState
  active: boolean
  /** The active video's subtitle segments, in file order. Empty until a
   * workspace is prepared. Text/timing lives in `transcripts[videoMediaId]`,
   * same as Story Narration -- never duplicated into DubbingWorkspaceState. */
  segments: TranscriptSegment[]
  getSegmentState: (segmentId: string) => DubbingSegmentState

  /** Whichever subtitle row is currently focused in the left panel -- purely
   * transient UI state, deliberately NOT part of the persisted
   * DubbingWorkspaceState (same convention as TimelineViewContext's
   * rangeSelection/activeKeyframeProperty). Lets VoiceModelPanel's card
   * click know which subtitle to assign the clicked voice to, without the
   * two panels needing a prop-drilled callback between them. */
  selectedSubtitleId: string | null
  setSelectedSubtitleId: (segmentId: string | null) => void
  /** Video selected on the Add Video/Add SRT screen before an SRT exists.
   * Shared with VoiceModelPanel so its Gemini Auto SRT button can run
   * without duplicating or prematurely adding the video to the timeline. */
  pendingVideoId: string | null
  setPendingVideoId: (mediaId: string | null) => void

  enterAiDubber: () => void
  exitAiDubber: () => void
  prepareWorkspace: (params: { videoMediaId: string; srtText: string; srtFileName: string }) => PrepareDubbingResult
  prepareDetectedWorkspace: (params: { videoMediaId: string; result: DetectSpeakersResult }) => PrepareDubbingResult

  updateSegmentText: (segmentId: string, text: string) => void
  updateSegmentTiming: (segmentId: string, edge: 'start' | 'end', time: number) => void
  /** Adds an empty subtitle at the playhead and selects it; returns its id. */
  addSubtitle: () => string
  /** Adds a subtitle at `time` (the Timeline's right-click "Add Subtitle
   * Here") and selects it. With no subtitles yet, `preferMediaId` (else the
   * video under that moment, else the first one) holds them from now on.
   * Null when there is no video to hold it. */
  addSubtitleAt: (time: number, preferMediaId?: string) => string | null
  /** Slides a subtitle to a new start time AND carries its generated dub
   * clip along by the same amount -- the Timeline's caption drag calls this
   * so the voice never gets left behind where the line used to be. */
  moveSubtitle: (segmentId: string, newStartTime: number) => void
  /** Group counterpart: every selected subtitle and generated dub clip
   * moves by the same amount. */
  moveSubtitles: (segmentIds: string[], draggedSegmentId: string, newStartTime: number) => void
  removeSubtitle: (segmentId: string) => void
  removeSubtitles: (segmentIds: string[]) => void

  setSegmentVoice: (segmentId: string, voiceId: string) => void
  /** Puts ONE voice on every subtitle at once, overwriting whatever each
   * one currently has. The bulk counterpart to setSegmentVoice: assigning a
   * single voice to a 200+ line script one row at a time isn't practical,
   * and it's also the only way to clear out stale per-row assignments left
   * behind by an earlier run (removing the code that wrote them doesn't
   * remove the values it already saved into the project). */
  setAllSegmentsVoice: (voiceId: string) => void
  setSegmentAgeGroup: (segmentId: string, ageGroup: DubbingSegmentState['ageGroup']) => void
  setSegmentIsNarrator: (segmentId: string, isNarrator: boolean) => void
  setSegmentControl: (segmentId: string, field: 'pitch' | 'speed' | 'volumeDb', value: number) => void
  renameSpeaker: (speakerId: string, name: string) => void
  setSpeakerGender: (speakerId: string, gender: SpeakerGender) => void
  setSpeakerAge: (speakerId: string, age: SpeakerAgeCategory) => void
  setSpeakerVoice: (speakerId: string, voiceId: string) => void
  mergeSpeakers: (sourceSpeakerId: string, targetSpeakerId: string) => void
  splitSpeaker: (speakerId: string, segmentIds: string[]) => string | null

  /** The "Custom Voice" card's own reference recording for VoxCPM2 voice
   * cloning -- see shared/dubbing.ts's DubbingWorkspaceState fields these
   * write to. Both need to be set (a real audio path + what it says) before
   * a segment assigned to 'custom-voice' can actually generate. */
  setCustomVoiceReferenceAudio: (path: string) => void
  setCustomVoiceReferenceText: (text: string) => void

  /** Real Male/Female/Unknown detection against the imported video's own
   * audio, per subtitle -- see app/main/media/speakerDetect.ts. Age group and
   * Narrator are never touched here (see shared/dubbing.ts). */
  /** `preferred`: the voice to suggest for each gender (the Detect Gender
   * review passes the user's own latest picks) instead of the plain one. */
  detectGenderForSegment: (segment: TranscriptSegment, preferred?: Partial<Record<'male' | 'female', string>>) => Promise<NarrationSpeaker>
  /** The video a line comes from and its start/end inside that file: after
   * Batch Load the Timeline holds several videos end to end, and a line's
   * Timeline time is not its time in the file. */
  sourceOfLine: (segment: TranscriptSegment) => { mediaId: string; start: number; end: number } | null

  /** "Generate Dubbing" -- real VoxCPM2 text-to-speech (see
   * app/main/media/voxcpmTts.ts), grouped per assigned voice. Per-line
   * results stream via window.api.dubbing.onGenerationProgress, not this
   * function's own return value. */
  generateDubbing: () => void
  /** Emotion + performance analysis (see shared/dubbingPerformance.ts).
   * No ids: every line not set by hand. With ids: exactly those lines,
   * replacing a manual performance too (the per-line Auto Detect). Gemini
   * reads each line with the lines around it; without Gemini (no key, no
   * credits, offline) the local analysis runs instead and says so. */
  detectEmotions: (segmentIds?: string[]) => Promise<void>
  /** True while detectEmotions is running; its last result message. */
  analysisRunning: boolean
  analysisMessage: string | null
  dismissAnalysisMessage: () => void
  /** Manual override of one line's performance -- from then on automatic
   * analysis leaves the line alone until Auto Detect is used on it. */
  setSegmentPerformance: (segmentId: string, patch: Partial<LinePerformance>) => void
  /** Drops the line's performance: it goes back to automatic analysis. */
  resetSegmentPerformance: (segmentId: string) => void
  /** A line is a thought (inner voice) and is dubbed with an echo -- set by
   * hand; automatic detection leaves it alone from then on. */
  setSegmentInnerVoice: (segmentId: string, on: boolean) => void
  /** Whether a line will be dubbed as an inner voice (hand choice, Gemini's
   * mark, subtitle text or detected echo -- see shared/innerVoice.ts). */
  isInnerVoice: (segmentId: string) => boolean
  /** Finds the inner-voice lines: subtitle text, and echo/reverb in the
   * original audio of each line (local, free). Hand choices are kept. */
  detectInnerVoices: () => Promise<void>
  innerVoiceRunning: boolean
  /** Generates just this line (with the take it belongs to) again, with a
   * new performance seed -- a different take of the same performance. */
  regenerateSegment: (segmentId: string) => void
  /** Makes this line's voice now with the given engine (whatever engine
   * Settings has), as a new take; `voiceId` also becomes the line's voice.
   * The Timeline's right-click "Generate with ..." on a subtitle. */
  generateSegmentWith: (segmentId: string, engine: DubbingEngine, voiceId?: string) => void
  /** Stops a running Generate Dubbing; finished takes are kept. */
  cancelGeneration: () => void
  /** Closes the error or note shown under Generate Dubbing (its ×). */
  dismissGenerationMessage: (kind: 'error' | 'note') => void

  /** Save/Reopen: restores the exact saved workspace state. Does not touch
   * `transcripts`/`sequence` -- those restore independently through their
   * own contexts, same as Story Narration's own `restore`. */
  restore: (saved: DubbingWorkspaceState) => void

  /** "Remove SRT" -- clears the loaded video/SRT and returns to the Add
   * Video/Add SRT setup screen, without leaving AI Dubber mode. Never
   * touches already-generated DUB1 clips on the Timeline. */
  clearWorkspace: () => void

  /** Auto-Sync -- puts every generated line back on its own subtitle's exact
   * start time, undoing any drift the delay-on-overrun placement introduced
   * during generation. Pure timeline move, no audio touched. */
  autoSyncDubClips: () => number
  /** Auto-Speed -- re-renders each generated line that runs past the room
   * before the next subtitle, faster by at most AUTO_SPEED_MAX (dubbingPlan
   * .ts) and only once per line, then re-syncs. It used to fit every line
   * exactly with no cap, and heavily sped lines were what made the voice
   * unclear; a line that still does not fit now runs a little late. */
  autoSpeedDubClips: () => Promise<number>
  /** True while an Auto-Speed pass is re-rendering audio. */
  autoSpeedRunning: boolean
  /** Video Sync -- for each line still longer than its room, the picture
   * (with its own sound and the music bed) plays slower under that line,
   * at most down to VIDEO_SYNC_MIN_RATE, and everything after moves later
   * -- subtitles included. The voice is not touched. Undo restores both. */
  videoSyncDubClips: () => { lines: number; addedSeconds: number; stillLong: number }
  /** Subtitles drawn on the video and blur boxes over the original ones
   * (shown in the Player, burned in by Export). */
  videoOverlay: VideoOverlaySettings
  setVideoOverlay: (update: (current: VideoOverlaySettings) => VideoOverlaySettings) => void
  /** The subtitles as drawn on the video: Timeline seconds, the edited
   * (Khmer) text when there is one. */
  overlayLines: OverlayLine[]
  /** The Subtitle & Blur panel is open: the Player shows the boxes' handles. */
  overlayEditing: boolean
  setOverlayEditing: (on: boolean) => void

  /** Series mode (see shared/dubbingEpisodes.ts): several episodes, Auto SRT
   * for all of them, dubbed one at a time -- each keeps its own subtitles
   * setup and its own Timeline. */
  episodes: DubbingEpisode[]
  addEpisodes: (mediaIds: string[]) => void
  removeEpisode: (mediaId: string) => void
  /** Parks the open episode (setup + Timeline) and brings this one in. */
  openEpisode: (mediaId: string) => void
  /** Gemini Auto SRT for every episode still waiting (or failed), one after
   * another. The first one finished opens by itself when none is open. */
  transcribeEpisodes: (onlyMediaIds?: string[]) => Promise<void>
  cancelEpisodeTranscription: () => void
  episodeJob: { mediaId: string; percent: number; message: string } | null
  episodeMessage: string | null
  dismissEpisodeMessage: () => void
  /** Folder picker, then `<video name>.srt` for every episode with subtitles. */
  saveEpisodeSrts: () => Promise<void>
  /** Generating or Auto-Speed is running: switching episodes waits. */
  episodeSwitchBlocked: boolean
  /** Add Video: file dialog, then the video(s) go straight onto the
   * Timeline -- one opens by itself, several become episodes. */
  importVideos: () => Promise<{ srtFileName?: string; srtWaiting: boolean }>
  /** Batch Auto SRT (shared/dubbingBatch.ts): the videos on the Timeline in
   * order, each with how far its Auto SRT got. */
  batchRows: (BatchPart & {
    fileName: string
    lines: number
    status: 'waiting' | 'transcribing' | 'done' | 'failed'
    error?: string
    /** Stretches of 20 s+ with no line -- possibly missed dialogue. */
    gaps: SubtitleGap[]
    /** Seconds Gemini could not transcribe cleanly on its last run. */
    unclearSeconds?: number
  })[]
  /** Sends only this video's gaps back to Gemini and adds whatever lines it
   * finds there; nothing already there is changed. */
  fillBatchGaps: (clipId: string) => Promise<void>
  /** Batch Load: pick videos, put them end to end on the Timeline in
   * episode order; with `transcribe`, Auto SRT them one by one after. */
  batchLoadVideos: (transcribe: boolean) => Promise<void>
  /** Gemini Auto SRT, one video at a time, each video's lines placed under
   * it on the Timeline. No ids: every video with no lines yet. */
  transcribeBatch: (onlyClipIds?: string[]) => Promise<void>
  cancelBatch: () => void
  /** Any number of SRTs at once: each goes under its own video on the
   * Timeline (matched by file name / episode number, else in order). */
  addSrtFiles: (files: { fileName: string; srtText: string }[]) => SrtPlacement
  batchJob: { clipId: string; percent: number; message: string } | null
  batchMessage: string | null
  dismissBatchMessage: () => void
  /** One SRT per video, in that video's own time, into a chosen folder. */
  saveBatchSrts: () => Promise<void>
  /** Auto SRT's Clear: every video of the list off the Timeline, with the
   * subtitles and dub made for them. */
  clearBatchVideos: () => void
  /** An SRT picked on the Add Video screen before any video: applied to
   * the video as soon as Add Video brings one in. */
  setPendingSrt: (srt: { srtText: string; srtFileName: string } | null) => void
}

const AiDubberContext = createContext<AiDubberContextValue | null>(null)

/** Every line as the performance analyzer sees it: the text as written
 * (emotion tags included -- cleanTextForSpeech only runs on the copy sent to
 * the voice engine), who says it, narrator or not, and its time on screen. */
function buildPerformanceInput(
  segments: TranscriptSegment[],
  segStates: DubbingWorkspaceState['segments'],
  speakers: DubbingWorkspaceState['speakers']
): PerformanceInputLine[] {
  return segments.map((seg) => {
    const st = segStates[seg.id]
    const speakerId = st?.speakerId ?? seg.speakerId
    return {
      id: seg.id,
      text: seg.editedText ?? seg.text,
      speaker: speakerId ? (speakers[speakerId]?.name ?? speakerId) : undefined,
      isNarrator: st?.isNarrator,
      startTime: seg.startTime,
      endTime: seg.endTime
    }
  })
}

/** A line and every line read in the same take (a line joined into a
 * neighbour's take can only be remade together with that take). */
function expandToTakes(ids: string[], segStates: DubbingWorkspaceState['segments']): Set<string> {
  const out = new Set<string>()
  for (const id of ids) {
    const leader = segStates[id]?.joinedInto ?? id
    out.add(id)
    out.add(leader)
    for (const st of Object.values(segStates)) if (st.joinedInto === leader) out.add(st.segmentId)
  }
  return out
}

const DEFAULT_NEW_SUBTITLE_DURATION = 2

/** An Auto SRT result as an episode's subtitles setup: its recurring
 * speakers, every line on its speaker, no voices picked yet. */
function detectedEpisodeWorkspace(result: DetectSpeakersResult): DubbingEpisodeWorkspace {
  const speakers = Object.fromEntries(result.speakers.map((speaker) => [speaker.id, speaker as DubbingSpeakerProfile]))
  const segments: DubbingWorkspaceState['segments'] = {}
  for (const segment of result.transcript.segments) {
    segments[segment.id] = {
      ...defaultDubbingSegmentState(segment.id),
      speakerId: segment.speakerId,
      // Auto SRT separates recurring voices only. It does not enter the
      // old Detect Gender workflow or auto-pick a voice from gender/age.
      detectedGender: 'unknown'
    }
  }
  return { srtFileName: result.srtFileName, generatedSrtPath: result.srtPath, genderDetectionStatus: 'idle', segments, speakers }
}

/** A saved performance is re-validated before it can reach the prompt
 * builder (a hand-edited or damaged project); lines without one simply get
 * one at their next Generate. */
function sanitizeSegmentPerformances(saved: DubbingWorkspaceState['segments'] | undefined): DubbingWorkspaceState['segments'] {
  const out: DubbingWorkspaceState['segments'] = {}
  for (const [id, line] of Object.entries(saved ?? {})) {
    const performance = line.performance ? sanitizePerformance(line.performance) : null
    const { performance: _raw, ...rest } = line
    out[id] = performance ? { ...rest, performance } : rest
  }
  return out
}

function sanitizeEpisodeWorkspace(workspace: DubbingEpisodeWorkspace | undefined): DubbingEpisodeWorkspace | undefined {
  return workspace ? { ...workspace, segments: sanitizeSegmentPerformances(workspace.segments), speakers: workspace.speakers ?? {} } : undefined
}

/** The episode list once `mediaId` is open with subtitles: it is done, and
 * the Timeline is now its. Nothing changes outside a series. */
function episodeOpenedWithSubtitles(episodes: DubbingEpisode[] | undefined, mediaId: string): Partial<DubbingWorkspaceState> {
  if (!episodes || episodes.length === 0) return {}
  return {
    episodes: episodes.map((e) => (e.mediaId === mediaId ? { ...e, status: 'done' as const, error: undefined, workspace: undefined, sequence: undefined } : e)),
    timelineEpisodeId: mediaId
  }
}

/** The VoxCPM2 folder from the voice-engine settings, for Auto SRT's
 * speech separation (main searches for one when this is empty). */
function storedVoxCpmInstallDir(): string | undefined {
  try {
    const settings = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey()))
    return settings.installDir || undefined
  } catch {
    return undefined
  }
}

export function AiDubberProvider({ children }: { children: ReactNode }): JSX.Element {
  const { items, importPaths, select: selectMedia } = useMedia()
  const { transcripts, setImportedTranscript, removeTranscript, updateSegmentText: updateTranscriptSegmentText, moveSegment, moveSegments, selectedModelId, language } = useTranscript()
  const { sequence, insertClip, ensureTrack, prepareDubbingTrack, acceptDubbingClip, setClipStartTimes, replaceClipMedia, deleteClipsById, restoreSequence } = useSequence()
  const { beginTransaction, endTransaction, resetHistory } = useHistory()
  const { seekTo } = usePlaybackControls()
  const { leftView, setLeftView, rightTab, setRightTab } = useUiState()
  const { currentTime } = usePlaybackTime()
  // Read through a ref by addSubtitle so a playhead that moves every frame
  // doesn't re-create that callback (and everything memoised on it) every
  // frame -- only the value at the moment of the click matters.
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime

  const [state, setState] = useState<DubbingWorkspaceState>(createDefaultDubbingWorkspaceState())
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null)
  const [pendingVideoId, setPendingVideoId] = useState<string | null>(null)

  // Captured once, at the moment AI Dubber is entered, so exiting restores
  // exactly what was showing before -- same trick as Story Narration's own
  // preEntryViewRef (see NarrationContext.tsx).
  const preEntryViewRef = useRef<{ leftView: LeftView; rightTab: RightTab } | null>(null)

  /** Every generated placeholder clip still waiting on its extract+import
   * round-trip, keyed by the saved file's own path -- a Map, not a single
   * scalar, since "Generate Dubbing" kicks off every subtitle's round-trip
   * at once (mirrors NarrationContext's pendingAcceptsRef exactly, but for
   * many segments in flight simultaneously rather than one at a time). */
  const pendingAcceptsRef = useRef<Map<string, { segmentId: string; startTime: number; clipId: string; previousClipId?: string }>>(new Map())

  /** A subtitle whose generated audio has already finished importing (so its
   * real, probed duration is known) but hasn't been placed onto DUB1 yet --
   * because doing so correctly requires knowing where its chronological
   * PREDECESSOR actually ends first (see placementCursorRef below). Keyed by
   * segment id, not path, since it's looked up by chronological position
   * from here on rather than by import event. */
  const readyForPlacementRef = useRef<Map<string, { mediaItem: MediaItem; clipId: string; previousClipId?: string }>>(new Map())

  /** A subtitle that will never produce a clip (generation failed, or its
   * import itself failed) -- tracked separately so tryDrainPlacementQueue
   * can skip over it instead of waiting forever for a clip that's never
   * coming. */
  const failedSegmentIdsRef = useRef<Set<string>>(new Set())

  /** How far chronological DUB placement has progressed for the CURRENT
   * batch, and where the next clip is allowed to start at the earliest --
   * `nextIndex` is an index into `segments` (already file/chronological
   * order). Reset at the top of every generateDubbing() call so a fresh
   * batch never inherits a previous run's cursor state. See
   * tryDrainPlacementQueue's own doc comment for why placement can't simply
   * happen in whatever order generation events arrive. */
  const placementCursorRef = useRef<{ nextIndex: number; runningEndTime: number }>({ nextIndex: 0, runningEndTime: 0 })
  /** This run's joined takes: first line's id -> the other lines it covers
   * (see dubbingPlan.ts's planGenerationUnits). */
  const joinedMembersRef = useRef<Map<string, string[]>>(new Map())
  /** Lines spoken inside another line's take -- they get no clip of their
   * own, so the placement queue steps over them like it steps over a
   * failed line, but they are not failures. */
  const coveredSegmentIdsRef = useRef<Set<string>>(new Set())
  /** Set by Cancel: progress events still in flight for this run are
   * ignored. Cleared when the next run starts. */
  const generationCanceledRef = useRef(false)

  const segments = useMemo(() => (state.videoMediaId ? (transcripts[state.videoMediaId]?.segments ?? []) : []), [state.videoMediaId, transcripts])

  // Always-latest values for the onGenerationProgress subscription below,
  // which is registered once for the whole provider lifetime (not
  // re-subscribed on every segments/state change) -- plain render-time
  // assignment, not a separate effect, matching ClipTrack.tsx's own
  // "latest closure via ref" convention for a stable callback that still
  // needs current data.
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const stateRef = useRef(state)
  stateRef.current = state

  const videoOriginalPath = useMemo(() => (state.videoMediaId ? items.find((m) => m.id === state.videoMediaId)?.originalPath : undefined), [state.videoMediaId, items])

  const getSegmentState = useCallback((segmentId: string) => state.segments[segmentId] ?? defaultDubbingSegmentState(segmentId), [state.segments])

  // Latest values for the episode functions below, which run across awaits
  // (a whole series of Auto SRT) and must never act on a stale render.
  const sequenceRef = useRef(sequence)
  sequenceRef.current = sequence
  const itemsRef = useRef(items)
  itemsRef.current = items
  const transcriptsRef = useRef(transcripts)
  transcriptsRef.current = transcripts
  const transcribeSettingsRef = useRef({ selectedModelId, language })
  transcribeSettingsRef.current = { selectedModelId, language }

  /** Puts a video at 0 on the first free video track of `onto` (the
   * Timeline these calls are about to change). */
  const insertVideoAtStart = useCallback(
    (onto: ProjectSequence, videoItem: MediaItem) => {
      const duration = videoItem.metadata?.durationSeconds ?? 0
      const occupied: OccupiedRange[] = onto.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
      const routing = findOrCreateTrack(onto.tracks, occupied, 0, duration, 'video')
      if (routing.newTrack) ensureTrack(routing.newTrack)
      // Inserted with its audio ON. An earlier version muted it here so the
      // generated DUB1 lines wouldn't play on top of the original
      // dialogue -- but that silenced the music and effects too, and
      // "why is the video silent" was the result. The right tool for
      // keeping the bed while losing the speech is Remove Vocal (right-
      // click the clip), which separates the two and mutes this clip
      // itself as part of placing the instrumental; a plain mute is one
      // click away for anyone who just wants the original quiet.
      insertClip(assetFromMediaItem(videoItem), 0, routing.trackId)
    },
    [ensureTrack, insertClip]
  )

  /** Makes the project Timeline the one for `mediaId`. In a series, the
   * Timeline belongs to one episode: the outgoing episode's Timeline (and,
   * if it is the open one, its subtitles setup) is parked in the episode
   * list and the incoming one's comes back -- or a new one with just its
   * video. Outside a series (or the first episode, which adopts whatever
   * Timeline is there) the video is simply put on the current Timeline if
   * it is not there yet. Changes the Timeline now; returns how the episode
   * list changes, applied inside the caller's setState so it builds on the
   * latest list (an Auto SRT result may have landed in the same tick). */
  const bringTimelineTo = useCallback(
    (mediaId: string, cur: DubbingWorkspaceState): ((prev: DubbingWorkspaceState) => DubbingEpisode[] | undefined) => {
      const videoItem = itemsRef.current.find((m) => m.id === mediaId)
      const live = sequenceRef.current
      // Once there is a series, every video dubbed here is one of its episodes.
      const withTarget = (list: DubbingEpisode[]): DubbingEpisode[] =>
        list.length > 0 && videoItem ? withEpisodesAdded(list, [{ mediaId, fileName: videoItem.fileName }]) : list
      const inSeries = withTarget(cur.episodes ?? []).length > 0
      const owner = cur.timelineEpisodeId ?? cur.videoMediaId
      if (inSeries && owner && owner !== mediaId) {
        const saved = cur.episodes?.find((e) => e.mediaId === mediaId)?.sequence
        // Not an edit: Undo must not step back into the other episode.
        resetHistory()
        if (saved) {
          restoreSequence(saved)
        } else {
          const fresh = createEmptySequence()
          restoreSequence(fresh)
          prepareDubbingTrack()
          if (videoItem) insertVideoAtStart(fresh, videoItem)
        }
        return (prev) => {
          let episodes = withTarget(prev.episodes ?? [])
          if (!episodes.some((e) => e.mediaId === owner)) {
            const ownerItem = itemsRef.current.find((m) => m.id === owner)
            episodes = withEpisodesAdded(episodes, [{ mediaId: owner, fileName: ownerItem?.fileName ?? owner }]).map((e) =>
              e.mediaId === owner ? { ...e, status: 'done' as const } : e
            )
          }
          return episodes.map((e) => {
            if (e.mediaId === owner) return { ...e, sequence: live, ...(owner === prev.videoMediaId ? { workspace: episodeWorkspaceOf(prev) } : {}) }
            return e.mediaId === mediaId ? { ...e, sequence: undefined } : e
          })
        }
      }
      // Spans the transcript and the sequence as one logical step -- one
      // Undo entry, same as NarrationContext.prepareWorkspace.
      beginTransaction()
      prepareDubbingTrack()
      // AI Dubber's own "Add Video" is a standalone entry point: without
      // this the video only lived in the Media panel, never on the Timeline
      // -- nothing to preview beside the dub clips or export. Skipped when
      // this exact media is already there (Add SRT again for the same video).
      if (videoItem && !live.clips.some((c) => c.mediaId === mediaId)) insertVideoAtStart(live, videoItem)
      endTransaction()
      return (prev) => (prev.episodes && prev.episodes.length > 0 ? withTarget(prev.episodes) : undefined)
    },
    [resetHistory, restoreSequence, prepareDubbingTrack, insertVideoAtStart, beginTransaction, endTransaction]
  )

  const enterAiDubber = useCallback(() => {
    preEntryViewRef.current = { leftView, rightTab }
    setState((prev) => ({ ...prev, active: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captured once on entry, deliberately not reactive to further leftView/rightTab changes.
  }, [])

  const exitAiDubber = useCallback(() => {
    setState((prev) => ({ ...prev, active: false }))
    setPendingVideoId(null)
    const restoreView = preEntryViewRef.current
    if (restoreView) {
      setLeftView(restoreView.leftView)
      setRightTab(restoreView.rightTab)
    }
    preEntryViewRef.current = null
  }, [setLeftView, setRightTab])

  const prepareWorkspace = useCallback(
    (params: { videoMediaId: string; srtText: string; srtFileName: string }): PrepareDubbingResult => {
      // An SRT exported from here may carry its dubbing setup (speakers,
      // male/female, voices, pitch/speed/volume) -- see shared/dubbingSrt.ts.
      const { srtText, data: dubbingData } = splitDubbingSrt(params.srtText)
      const { segments: cues, issues } = parseSrtToSegments(srtText)
      const restored = dubbingData ? restoreDubbingWorkspace(cues, dubbingData) : null
      // Speaker identity lives on the transcript line too (the Speaker chips
      // and character list read it there).
      const parsedSegments = restored ? cues.map((cue) => (restored.speakerIdBySegmentId[cue.id] ? { ...cue, speakerId: restored.speakerIdBySegmentId[cue.id] } : cue)) : cues

      const transcript: Transcript = {
        mediaId: params.videoMediaId,
        segments: parsedSegments,
        requestedLanguage: 'auto',
        generatedAt: new Date().toISOString(),
        audioSourcePath: '',
        source: 'srt'
      }

      setImportedTranscript(params.videoMediaId, transcript)
      selectMedia(params.videoMediaId)
      const parkedEpisodes = bringTimelineTo(params.videoMediaId, stateRef.current)

      // Recap Script's My Voice choice (savedVoices.ts's story narrator)
      // becomes every line's voice from the start -- marked as a manual
      // pick so gender detection never swaps it out. Only if that voice
      // still exists; a deleted one just leaves lines on auto.
      // (A restored SRT keeps its own voices instead.)
      const narratorVoiceId = loadStoryNarratorVoiceId()
      const narratorExists = narratorVoiceId ? !!findSavedVoice(loadSavedVoices(), narratorVoiceId) || !!kiriVoiceOf(narratorVoiceId) : false
      const initialSegments: DubbingWorkspaceState['segments'] = {}
      if (!restored && narratorVoiceId && narratorExists) {
        for (const seg of parsedSegments) {
          initialSegments[seg.id] = { ...defaultDubbingSegmentState(seg.id), voiceId: narratorVoiceId, voiceManuallyAssigned: true, status: 'voice-assigned' }
        }
      }
      setState((prev) => ({
        ...prev,
        active: true,
        videoMediaId: params.videoMediaId,
        srtFileName: params.srtFileName,
        generatedSrtPath: undefined,
        segments: restored ? restored.segments : initialSegments,
        speakers: restored ? restored.speakers : {},
        // Genders came back with the file: no need to detect them again.
        genderDetectionStatus: restored && Object.values(restored.segments).some((s) => s.detectedGender !== 'unknown') ? 'detected' : 'idle',
        ...episodeOpenedWithSubtitles(parkedEpisodes(prev), params.videoMediaId)
      }))
      setPendingVideoId(null)

      const issueWarnings = issues.map((i) => `Segment ${i.blockIndex + 1}: ${i.reason}`)
      if (restored?.mismatch) {
        issueWarnings.push(`This SRT's saved voice setup was for ${dubbingData!.lines.length} lines but it now has ${cues.length} -- lines were matched in order; check the voices.`)
      }
      return { segmentCount: parsedSegments.length, warnings: issueWarnings }
    },
    [setImportedTranscript, selectMedia, bringTimelineTo]
  )

  const prepareDetectedWorkspace = useCallback(
    (params: { videoMediaId: string; result: DetectSpeakersResult }): PrepareDubbingResult => {
      const transcript = params.result.transcript
      setImportedTranscript(params.videoMediaId, transcript)
      selectMedia(params.videoMediaId)
      const parkedEpisodes = bringTimelineTo(params.videoMediaId, stateRef.current)
      const workspace = detectedEpisodeWorkspace(params.result)
      setState((previous) => ({
        ...previous,
        active: true,
        videoMediaId: params.videoMediaId,
        ...workspace,
        ...episodeOpenedWithSubtitles(parkedEpisodes(previous), params.videoMediaId)
      }))
      setPendingVideoId(null)
      return { segmentCount: transcript.segments.length, warnings: [] }
    },
    [setImportedTranscript, selectMedia, bringTimelineTo]
  )

  const replaceSegments = useCallback(
    (nextSegments: TranscriptSegment[]) => {
      if (!state.videoMediaId) return
      const existing = transcripts[state.videoMediaId]
      setImportedTranscript(state.videoMediaId, {
        mediaId: state.videoMediaId,
        segments: nextSegments,
        requestedLanguage: existing?.requestedLanguage ?? 'auto',
        generatedAt: new Date().toISOString(),
        audioSourcePath: existing?.audioSourcePath ?? '',
        source: existing?.source ?? 'srt'
      })
    },
    [state.videoMediaId, transcripts, setImportedTranscript]
  )

  const updateSegmentText = useCallback(
    (segmentId: string, text: string) => {
      if (!state.videoMediaId) return
      updateTranscriptSegmentText(state.videoMediaId, segmentId, text)
    },
    [state.videoMediaId, updateTranscriptSegmentText]
  )

  const updateSegmentTiming = useCallback(
    (segmentId: string, edge: 'start' | 'end', time: number) => {
      const next = segments.map((s) => {
        if (s.id !== segmentId) return s
        const startTime = edge === 'start' ? Math.max(0, Math.min(time, s.endTime - 0.05)) : s.startTime
        const endTime = edge === 'end' ? Math.max(s.startTime + 0.05, time) : s.endTime
        return { ...s, startTime, endTime, words: s.words.map((w) => ({ ...w, startTime, endTime })) }
      })
      replaceSegments(next)
    },
    [segments, replaceSegments]
  )

  const addSubtitleAt = useCallback(
    (time: number, preferMediaId?: string): string | null => {
      const startTime = Math.max(0, time)
      const endTime = startTime + DEFAULT_NEW_SUBTITLE_DURATION
      const id = crypto.randomUUID()
      const newSegment: TranscriptSegment = {
        id,
        words: [{ text: '', startTime, endTime, confidence: 1 }],
        startTime,
        endTime,
        language: 'auto',
        confidence: 1,
        text: '',
        needsReview: false
      }
      let holder = state.videoMediaId
      if (!holder) {
        // No subtitles yet: a video takes them (and the dub track is made),
        // as Add Video does -- the chosen one, else the one playing at
        // that moment, else the first on the Timeline.
        const videoClips = sequence.clips.filter((clip) => clip.type === 'video').sort((a, b) => a.startTime - b.startTime)
        const under = videoClips.find((clip) => clip.startTime <= startTime && clip.startTime + clip.duration > startTime)
        holder = (preferMediaId && videoClips.some((clip) => clip.mediaId === preferMediaId) ? preferMediaId : undefined) ?? under?.mediaId ?? videoClips[0]?.mediaId
        if (!holder) return null
        const opened = holder
        setState((prev) => (prev.videoMediaId ? prev : { ...prev, videoMediaId: opened }))
        selectMedia(opened)
        prepareDubbingTrack()
      }
      const existing = transcripts[holder]
      setImportedTranscript(holder, {
        mediaId: holder,
        segments: [...(existing?.segments ?? []), newSegment].sort((a, b) => a.startTime - b.startTime),
        requestedLanguage: existing?.requestedLanguage ?? 'auto',
        generatedAt: new Date().toISOString(),
        audioSourcePath: existing?.audioSourcePath ?? '',
        source: existing?.source ?? 'srt'
      })
      setSelectedSubtitleId(id)
      return id
    },
    [state.videoMediaId, sequence.clips, transcripts, setImportedTranscript, selectMedia, prepareDubbingTrack]
  )

  const addSubtitle = useCallback((): string => {
    // At the playhead, not after the last line: the user has already
    // scrubbed to the moment the new line belongs to, so that IS where it
    // goes. Inserted in time order rather than appended, so the row list
    // (walked chronologically everywhere) shows it in place.
    const startTime = Math.max(0, currentTimeRef.current)
    const endTime = startTime + DEFAULT_NEW_SUBTITLE_DURATION
    const id = crypto.randomUUID()
    const newSegment: TranscriptSegment = {
      id,
      words: [{ text: '', startTime, endTime, confidence: 1 }],
      startTime,
      endTime,
      language: 'auto',
      confidence: 1,
      text: '',
      needsReview: false
    }
    replaceSegments([...segments, newSegment].sort((a, b) => a.startTime - b.startTime))
    setSelectedSubtitleId(id)
    return id
  }, [segments, replaceSegments])

  const removeSubtitles = useCallback(
    (segmentIds: string[]) => {
      if (segmentIds.length === 0) return
      const ids = new Set(segmentIds)
      // The subtitle's generated dub clip goes with it. This only ever
      // removed the row and its bookkeeping, so the audio it had produced
      // stayed on DUB1 as an orphan -- a line the user had just deleted
      // still played back from the Timeline.
      const generatedClipIds = segmentIds.map((id) => state.segments[id]?.generatedClipId).filter((id): id is string => Boolean(id))
      if (generatedClipIds.length > 0) deleteClipsById(generatedClipIds)
      replaceSegments(segments.filter((s) => !ids.has(s.id)))
      setState((prev) => {
        if (!segmentIds.some((id) => prev.segments[id])) return prev
        const next = { ...prev.segments }
        for (const id of segmentIds) delete next[id]
        const speakers = Object.fromEntries(Object.entries(prev.speakers).flatMap(([speakerId, speaker]) => {
          const remaining = speaker.segmentIds.filter((id) => !ids.has(id))
          return remaining.length ? [[speakerId, { ...speaker, segmentIds: remaining }]] : []
        }))
        return { ...prev, segments: next, speakers }
      })
    },
    [segments, replaceSegments, state.segments, deleteClipsById]
  )

  const removeSubtitle = useCallback((segmentId: string) => removeSubtitles([segmentId]), [removeSubtitles])

  const moveSubtitle = useCallback(
    (segmentId: string, newStartTime: number) => {
      const seg = segments.find((s) => s.id === segmentId)
      if (!seg || !state.videoMediaId) return
      // Where the caption actually landed (it may have been nudged off a
      // neighbour, or refused) -- the clip follows THAT, not the request.
      const landed = moveSegment(state.videoMediaId, segmentId, newStartTime)
      if (landed === null) return
      const delta = landed - seg.startTime
      if (delta === 0) return
      // Shift the clip by the same delta rather than snapping it to the new
      // start: generation may have placed it slightly after its subtitle to
      // avoid overlapping the previous line (see tryDrainPlacementQueue),
      // and that offset is worth keeping.
      const clipId = state.segments[segmentId]?.generatedClipId
      const clip = clipId ? sequence.clips.find((c) => c.id === clipId) : undefined
      if (clip) setClipStartTimes([{ clipId: clip.id, startTime: Math.max(0, clip.startTime + delta) }])
    },
    [segments, state.videoMediaId, state.segments, moveSegment, sequence.clips, setClipStartTimes]
  )

  const moveSubtitles = useCallback(
    (segmentIds: string[], draggedSegmentId: string, newStartTime: number) => {
      if (!state.videoMediaId || segmentIds.length === 0) return
      const delta = moveSegments(state.videoMediaId, segmentIds, draggedSegmentId, newStartTime)
      if (delta === null || delta === 0) return
      const placements = segmentIds.flatMap((segmentId) => {
        const clipId = state.segments[segmentId]?.generatedClipId
        const clip = clipId ? sequence.clips.find((candidate) => candidate.id === clipId) : undefined
        return clip ? [{ clipId: clip.id, startTime: Math.max(0, clip.startTime + delta) }] : []
      })
      if (placements.length > 0) setClipStartTimes(placements)
    },
    [state.videoMediaId, state.segments, moveSegments, sequence.clips, setClipStartTimes]
  )

  const setSegmentVoice = useCallback((segmentId: string, voiceId: string) => {
    setState((prev) => ({
      ...prev,
      segments: {
        ...prev.segments,
        [segmentId]: { ...(prev.segments[segmentId] ?? defaultDubbingSegmentState(segmentId)), voiceId, voiceManuallyAssigned: true, status: 'voice-assigned' }
      }
    }))
  }, [])

  const setAllSegmentsVoice = useCallback(
    (voiceId: string) => {
      setState((prev) => {
        const next = { ...prev.segments }
        for (const seg of segments) {
          next[seg.id] = { ...(next[seg.id] ?? defaultDubbingSegmentState(seg.id)), voiceId, voiceManuallyAssigned: true, status: 'voice-assigned' }
        }
        return { ...prev, segments: next }
      })
    },
    [segments]
  )

  const setSegmentAgeGroup = useCallback((segmentId: string, ageGroup: DubbingSegmentState['ageGroup']) => {
    setState((prev) => ({
      ...prev,
      segments: { ...prev.segments, [segmentId]: { ...(prev.segments[segmentId] ?? defaultDubbingSegmentState(segmentId)), ageGroup } }
    }))
  }, [])

  const setSegmentIsNarrator = useCallback((segmentId: string, isNarrator: boolean) => {
    setState((prev) => ({
      ...prev,
      segments: { ...prev.segments, [segmentId]: { ...(prev.segments[segmentId] ?? defaultDubbingSegmentState(segmentId)), isNarrator } }
    }))
  }, [])

  const setSegmentControl = useCallback((segmentId: string, field: 'pitch' | 'speed' | 'volumeDb', value: number) => {
    setState((prev) => ({
      ...prev,
      segments: { ...prev.segments, [segmentId]: { ...(prev.segments[segmentId] ?? defaultDubbingSegmentState(segmentId)), [field]: value } }
    }))
  }, [])

  const renameSpeaker = useCallback((speakerId: string, name: string) => {
    if (!name.trim()) return
    setState((previous) => {
      const speaker = previous.speakers[speakerId]
      if (!speaker) return previous
      return { ...previous, speakers: { ...previous.speakers, [speakerId]: { ...speaker, name } } }
    })
  }, [])

  const setSpeakerGender = useCallback((speakerId: string, gender: SpeakerGender) => {
    setState((previous) => {
      const speaker = previous.speakers[speakerId]
      if (!speaker) return previous
      const nextSegments = { ...previous.segments }
      for (const segmentId of speaker.segmentIds) {
        nextSegments[segmentId] = { ...(nextSegments[segmentId] ?? defaultDubbingSegmentState(segmentId)), detectedGender: gender }
      }
      return {
        ...previous,
        segments: nextSegments,
        speakers: { ...previous.speakers, [speakerId]: { ...speaker, gender, genderManualOverride: true } }
      }
    })
  }, [])

  const setSpeakerAge = useCallback((speakerId: string, ageCategory: SpeakerAgeCategory) => {
    setState((previous) => {
      const speaker = previous.speakers[speakerId]
      if (!speaker) return previous
      const nextSegments = { ...previous.segments }
      for (const segmentId of speaker.segmentIds) {
        nextSegments[segmentId] = { ...(nextSegments[segmentId] ?? defaultDubbingSegmentState(segmentId)), ageGroup: ageCategory }
      }
      return {
        ...previous,
        segments: nextSegments,
        speakers: { ...previous.speakers, [speakerId]: { ...speaker, ageCategory, ageManualOverride: true } }
      }
    })
  }, [])

  const setSpeakerVoice = useCallback((speakerId: string, voiceId: string) => {
    setState((previous) => {
      const speaker = previous.speakers[speakerId]
      if (!speaker) return previous
      const nextSegments = { ...previous.segments }
      for (const segmentId of speaker.segmentIds) {
        const existing = nextSegments[segmentId] ?? defaultDubbingSegmentState(segmentId)
        nextSegments[segmentId] = { ...existing, voiceId, voiceManuallyAssigned: true, status: voiceId ? 'voice-assigned' : 'pending' }
      }
      return {
        ...previous,
        segments: nextSegments,
        speakers: { ...previous.speakers, [speakerId]: { ...speaker, voiceId, voiceManuallyAssigned: true } }
      }
    })
  }, [])

  const mergeSpeakers = useCallback((sourceSpeakerId: string, targetSpeakerId: string) => {
    if (sourceSpeakerId === targetSpeakerId) return
    const source = state.speakers[sourceSpeakerId]
    const target = state.speakers[targetSpeakerId]
    if (!source || !target) return
    const sourceWeight = Math.max(1, source.segmentIds.length)
    const targetWeight = Math.max(1, target.segmentIds.length)
    const dimension = Math.max(source.embedding.length, target.embedding.length)
    const embedding = Array.from({ length: dimension }, (_, index) =>
      (((target.embedding[index] ?? 0) * targetWeight) + ((source.embedding[index] ?? 0) * sourceWeight)) / (targetWeight + sourceWeight)
    )
    const segmentIds = [...new Set([...target.segmentIds, ...source.segmentIds])]
    replaceSegments(segments.map((segment) => source.segmentIds.includes(segment.id) ? { ...segment, speakerId: targetSpeakerId } : segment))
    setState((previous) => {
      const speakers = { ...previous.speakers }
      delete speakers[sourceSpeakerId]
      speakers[targetSpeakerId] = {
        ...target,
        embedding,
        segmentIds,
        mergedFrom: [...new Set([...(target.mergedFrom ?? []), sourceSpeakerId, ...(source.mergedFrom ?? [])])]
      }
      const nextSegments = { ...previous.segments }
      for (const segmentId of source.segmentIds) {
        const existing = nextSegments[segmentId] ?? defaultDubbingSegmentState(segmentId)
        nextSegments[segmentId] = {
          ...existing,
          speakerId: targetSpeakerId,
          voiceId: target.voiceId ?? existing.voiceId,
          voiceManuallyAssigned: target.voiceId ? true : existing.voiceManuallyAssigned
        }
      }
      return { ...previous, speakers, segments: nextSegments }
    })
  }, [state.speakers, segments, replaceSegments])

  const splitSpeaker = useCallback((speakerId: string, segmentIds: string[]): string | null => {
    const source = state.speakers[speakerId]
    const moving = [...new Set(segmentIds)].filter((segmentId) => source?.segmentIds.includes(segmentId))
    if (!source || moving.length === 0 || moving.length >= source.segmentIds.length) return null
    const newId = `speaker-${Date.now().toString(36)}`
    replaceSegments(segments.map((segment) => moving.includes(segment.id) ? { ...segment, speakerId: newId, speakerConfidence: undefined } : segment))
    setState((previous) => {
      const nextSegments = { ...previous.segments }
      for (const segmentId of moving) {
        nextSegments[segmentId] = { ...(nextSegments[segmentId] ?? defaultDubbingSegmentState(segmentId)), speakerId: newId, voiceId: undefined, voiceManuallyAssigned: false, status: 'pending' }
      }
      return {
        ...previous,
        segments: nextSegments,
        speakers: {
          ...previous.speakers,
          [speakerId]: { ...source, segmentIds: source.segmentIds.filter((segmentId) => !moving.includes(segmentId)) },
          [newId]: {
            ...source,
            id: newId,
            name: `Speaker ${Object.keys(previous.speakers).length + 1}`,
            segmentIds: moving,
            identityConfidence: Math.min(source.identityConfidence, 0.5),
            voiceId: undefined,
            voiceManuallyAssigned: false,
            mergedFrom: undefined
          }
        }
      }
    })
    return newId
  }, [state.speakers, segments, replaceSegments])

  const setCustomVoiceReferenceAudio = useCallback((path: string) => {
    setState((prev) => ({ ...prev, customVoiceReferenceAudioPath: path }))
  }, [])

  const setCustomVoiceReferenceText = useCallback((text: string) => {
    setState((prev) => ({ ...prev, customVoiceReferenceText: text }))
  }, [])

  // Real Male/Female/Unknown detection for ONE segment, against the
  // original video's own audio over its exact time range (see
  // app/main/media/speakerDetect.ts). Called by DetectGenderReviewModal.tsx
  // on-demand as the user steps through segments. Returns the resolved
  // speaker ('unknown' on any failure, e.g. ffmpeg unavailable) so a caller
  // that cares (the modal's own "Suggested" badge) doesn't have to re-read
  // state immediately after an async setState.
  const sourceOfLine = useCallback((segment: TranscriptSegment) => {
    const found = lineSource(batchPartsOf(sequenceRef.current), segment.startTime, segment.endTime)
    if (found) return found
    // No video clip under it: the open video, times as they are.
    const mediaId = stateRef.current.videoMediaId
    return mediaId ? { mediaId, start: segment.startTime, end: segment.endTime } : null
  }, [])

  const detectGenderForSegment = useCallback(
    async (segment: TranscriptSegment, preferred?: Partial<Record<'male' | 'female', string>>): Promise<NarrationSpeaker> => {
      // The line's own video and time in it (episode 2's lines are in
      // episode 2's file, not the first video's).
      const source = sourceOfLine(segment)
      const sourcePath = source ? itemsRef.current.find((m) => m.id === source.mediaId)?.originalPath : undefined
      if (!source || !sourcePath) return 'unknown'
      try {
        const result = await window.api.narration.detectSpeaker(`dub-gender-${segment.id}`, sourcePath, source.start, source.end)
        setState((prev) => {
          const existing = prev.segments[segment.id] ?? defaultDubbingSegmentState(segment.id)
          const speaker = result.speaker as NarrationSpeaker
          // Detection maps to the ONE matching voice -- male -> the male
          // voice, female -> the female voice -- replacing a stale
          // auto-assigned voice left over from an earlier run. But NEVER a
          // voice the user picked by hand: this call is async (an ffmpeg
          // extract plus pitch analysis), and the review fires it the moment
          // a segment appears, so a quick click on a saved recording could
          // land before it resolved -- and then be overwritten here with
          // Female Adult. That was "why is the clone mixed with another
          // voice even though I chose ស្រីមាប់". Deliberately NOT a "pick a
          // different voice each time to tell characters apart" heuristic
          // -- that handed out voices nobody chose (Anime Boy on a drama
          // line).
          // On KiriTTS the matching voice is its own Khmer one (Nita /
          // Chanda), so the review highlights a voice that will really speak.
          const engine = parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey())).engine
          const recommended =
            (speaker !== 'unknown' ? preferred?.[speaker] : undefined) ??
            (engine === 'kiritts' && speaker !== 'unknown' ? kiriVoiceId(speaker === 'female' ? KIRI_FALLBACK_FEMALE : KIRI_FALLBACK_MALE) : recommendVoiceId(speaker))
          const voiceId = existing.voiceManuallyAssigned ? existing.voiceId : (recommended ?? existing.voiceId)
          return {
            ...prev,
            segments: {
              ...prev.segments,
              [segment.id]: {
                ...existing,
                detectedGender: speaker,
                detectedConfidence: result.confidence,
                voiceId,
                status: existing.status === 'pending' && voiceId ? 'voice-assigned' : existing.status
              }
            }
          }
        })
        return result.speaker as NarrationSpeaker
      } catch {
        // ffmpeg unavailable or extraction failed -- leaves this segment at
        // 'unknown', same as never having attempted detection at all.
        return 'unknown'
      }
    },
    [sourceOfLine]
  )

  // Places every subtitle whose generated audio is ready, strictly in the
  // SRT's own chronological order, regardless of what order generation
  // actually finished in. This matters because generation is batched per
  // VOICE (one VoxCPM2 run per voice, to pay its model-load cost once) --
  // segment 6 (say, a male character) can finish well before segment 5 (a
  // female character) even starts, if the male batch happens to run first.
  // Placing clips in arrival order would let a later line "borrow" an
  // earlier, unrelated clip's end time and corrupt the dialogue's own order.
  // So each clip's actual start is `max(its own subtitle startTime, the
  // real end time of whichever clip immediately precedes it in the video)`,
  // and that predecessor's real end time is only knowable once the
  // predecessor itself has already been placed -- hence a strict cursor
  // that only advances past a segment once it's either ready or confirmed
  // failed, buffering anything that finishes early out of turn in
  // readyForPlacementRef until its turn comes. This is what guarantees two
  // dub lines are never audible at once WITHOUT ever truncating either of
  // them -- an overrunning line still plays in full, it just pushes
  // whatever comes after it a little later (self-healing: a later line with
  // a natural gap before it resolves back to its own original timestamp via
  // the Math.max below, never carrying drift further than it has to). */
  const tryDrainPlacementQueue = useCallback(() => {
    const cursor = placementCursorRef.current
    while (cursor.nextIndex < segmentsRef.current.length) {
      const seg = segmentsRef.current[cursor.nextIndex]
      if (failedSegmentIdsRef.current.has(seg.id) || coveredSegmentIdsRef.current.has(seg.id)) {
        cursor.nextIndex++
        continue
      }
      const ready = readyForPlacementRef.current.get(seg.id)
      if (!ready) break // still waiting on this one -- nothing later can go yet either
      readyForPlacementRef.current.delete(seg.id)

      const adjustedStart = Math.max(seg.startTime, cursor.runningEndTime)
      acceptDubbingClip(DUBBING_TRACK_ID, adjustedStart, assetFromMediaItem(ready.mediaItem), ready.clipId, ready.previousClipId)
      // A joined take covers its other lines too: they share this clip, and
      // any clip one of them had from an earlier, separate generation goes.
      const members = joinedMembersRef.current.get(seg.id) ?? []
      const staleClipIds = [...new Set(members.map((id) => stateRef.current.segments[id]?.generatedClipId).filter((id): id is string => !!id && id !== ready.previousClipId && id !== ready.clipId))]
      if (staleClipIds.length > 0) deleteClipsById(staleClipIds)
      setState((prev) => {
        const next = { ...prev.segments, [seg.id]: { ...(prev.segments[seg.id] ?? defaultDubbingSegmentState(seg.id)), status: 'generated' as const, generatedClipId: ready.clipId } }
        for (const id of members) next[id] = { ...(next[id] ?? defaultDubbingSegmentState(id)), status: 'generated', generatedClipId: ready.clipId, joinedInto: seg.id }
        return { ...prev, segments: next }
      })
      cursor.runningEndTime = adjustedStart + (ready.mediaItem.metadata?.durationSeconds ?? 0)
      cursor.nextIndex++
    }
  }, [acceptDubbingClip, deleteClipsById])

  // Real VoxCPM2 generation -- groups every subtitle by its assigned voice
  // (an unassigned segment falls back to its detected-gender recommendation,
  // then to a plain adult male voice as the last resort, rather than
  // blocking the whole batch on one unconfigured row), resolves each
  // group's `--control` voice-design instruction from the catalog (or the
  // Custom Voice card's own reference-audio clone settings), and fires ONE
  // window.api.dubbing.generateBatch call for the whole thing. Per-line
  // results stream back via the onGenerationProgress subscription below,
  // not this function's own return value -- see that effect's doc comment
  // for why, and shared/dubbing.ts's DUBBING_IPC.generationProgress.
  const runGeneration = useCallback((onlyIds: string[] | undefined, segStates: DubbingWorkspaceState['segments'], engineOverride?: DubbingEngine) => {
    if (segments.length === 0) return

    // A fresh batch never inherits a previous run's placement progress.
    generationCanceledRef.current = false
    placementCursorRef.current = { nextIndex: 0, runningEndTime: 0 }
    readyForPlacementRef.current.clear()
    failedSegmentIdsRef.current.clear()

    const storedSettings = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey()))
    // One line made with another engine than Settings' (the Timeline's
    // "Generate with ..."): just this run.
    const settings = engineOverride ? { ...storedSettings, engine: engineOverride } : storedSettings

    // Every line is acted. A line nobody analysed yet (no Detect Emotions
    // run, a line added since, a project saved before performances) gets
    // the local analysis now, read with its neighbours for context; lines
    // analysed by Gemini or set by hand keep theirs.
    const perfInput = buildPerformanceInput(segments, segStates, state.speakers)
    const filled: Record<string, LinePerformance> = perfInput.some((line) => !segStates[line.id]?.performance) ? analyzePerformancesByRules(perfInput) : {}
    // Steady voice speed: the emotion stays, its slower/faster pace does not.
    const performanceOf = (id: string): LinePerformance | undefined => {
      const performance = segStates[id]?.performance ?? filled[id]
      return performance && settings.steadyPace && performance.pace !== 'normal' ? { ...performance, pace: 'normal' } : performance
    }

    // Regenerate: only these lines (and the takes they belong to).
    const targetIds = onlyIds ? expandToTakes(onlyIds, segStates) : null
    const isTarget = (id: string): boolean => !targetIds || targetIds.has(id)

    // `segments` is already every subtitle in the WHOLE video, in file/
    // chronological order -- built here, before segments get split by voice
    // below, so the main process can cap each line against when the very
    // next character's own line starts regardless of which voice group
    // either one ends up in (see shared/dubbing.ts's
    // DubbingGenerationGroupSegment.nextSegmentStartTime doc comment).
    const nextStartById = new Map<string, number>()
    for (let i = 0; i < segments.length - 1; i++) {
      nextStartById.set(segments[i].id, segments[i + 1].startTime)
    }

    // Whatever voice a segment actually carries is used VERBATIM -- never
    // substituted for a "more varied" one. A segment with no voice of its
    // own falls back to the plain voice matching its detected gender, so
    // the same detection always produces the same voice: detect female ->
    // a female voice, detect male -> a male voice, pick Male Adult -> Male
    // Adult on every one of those lines. (An earlier version handed out a
    // different unused catalog voice per pitch cluster here, trying to tell
    // same-gender characters apart automatically -- that produced voices
    // nobody asked for, like Anime Boy or Movie Hero, on lines the user had
    // already set to Male Adult. Differentiating characters is done by
    // picking each one's voice in the Detect Gender review, not guessed.)
    // Read at generation time rather than held in state: the list lives in
    // localStorage and can be edited from the Voice Model panel at any point
    // between runs.
    const savedVoices = loadSavedVoices()

    // Lines with nothing to say ("♪♪", "…", "[Music]") are not sent to the
    // voice engine at all -- Edge TTS fails them with NoAudioReceived and
    // VoxCPM2 would voice noise. They get no clip; the placement queue skips
    // them exactly as it skips a failed line, without marking them failed.
    const speakableSegments = segments.filter((seg) => isTarget(seg.id) && hasSpeakableText(seg.editedText ?? seg.text))
    const silentCount = segments.filter((seg) => isTarget(seg.id)).length - speakableSegments.length
    for (const seg of segments) {
      // Lines this run does not make (silent ones, and on Regenerate every
      // other line) are stepped over by the placement queue.
      if (!isTarget(seg.id) || !hasSpeakableText(seg.editedText ?? seg.text)) failedSegmentIdsRef.current.add(seg.id)
    }
    const silentNote = silentCount > 0 ? `${silentCount} line${silentCount === 1 ? ' has' : 's have'} no words to speak (only symbols like ♪ or …, or a [note]) — skipped, no voice made for ${silentCount === 1 ? 'it' : 'them'}.` : undefined
    // Lines still in Chinese (an untranslated drama subtitle): Edge's Khmer
    // voices return no audio for them at all, VoxCPM2 would speak Chinese.
    // Said before the run, so nobody waits for failures to find out.
    const untranslated = speakableSegments.filter((seg) => unreadableScriptFor(cleanTextForSpeech(seg.editedText ?? seg.text), 'km'))
    const untranslatedNote =
      untranslated.length > 0
        ? `${untranslated.length} line${untranslated.length === 1 ? ' is' : 's are'} still in ${unreadableScriptFor(cleanTextForSpeech(untranslated[0].editedText ?? untranslated[0].text), 'km')} (first: line ${segments.indexOf(untranslated[0]) + 1}) — ${settings.engine === 'edge-tts' ? 'the Khmer voice cannot read them, so they will fail' : 'they will be spoken in that language, not Khmer'}. Use Translate to Khmer first.`
        : undefined
    const generationNote = [untranslatedNote, silentNote].filter(Boolean).join(' ') || undefined
    if (speakableSegments.length === 0) {
      setState((prev) => ({ ...prev, generationProgress: undefined, generationError: undefined, generationNote }))
      return
    }

    // Each line's voice: its own pick, else its speaker's pick, else the
    // voice matching its (or its speaker's) gender -- see dubbingPlan.ts's
    // resolveLineVoice. Edge TTS speaks a cloned voice in its own Khmer
    // voice of the same gender: the engine the user picked is the engine
    // that runs.
    const plannedLines: PlannedLine[] = speakableSegments.map((seg) => {
      const segState = segStates[seg.id] ?? defaultDubbingSegmentState(seg.id)
      const speakerId = segState.speakerId ?? seg.speakerId
      const { voiceId } = resolveLineVoice(segState, speakerId ? state.speakers[speakerId] : undefined, settings.engine, (id) => kiriCopyOf(id))
      return {
        id: seg.id,
        // Cleaned for the TTS engine only -- the subtitle's own displayed
        // text/editedText is never touched (see ttsTextCleaning.ts).
        text: cleanTextForSpeech(seg.editedText ?? seg.text),
        startTime: seg.startTime,
        endTime: seg.endTime,
        voiceId,
        pitch: segState.pitch,
        speed: segState.speed,
        volumeDb: segState.volumeDb,
        performance: performanceOf(seg.id),
        takeNonce: segState.takeNonce ?? 0,
        innerVoice: effectiveInnerVoice(segState, seg)
      }
    })
    // Neighbouring lines in the same voice are read as ONE take, so the
    // voice phrases them naturally instead of restarting on every fragment.
    const units = planGenerationUnits(plannedLines)
    joinedMembersRef.current = new Map(units.filter((unit) => unit.memberIds.length > 0).map((unit) => [unit.leaderId, unit.memberIds]))
    coveredSegmentIdsRef.current = new Set(units.flatMap((unit) => unit.memberIds))
    const lastLineOfUnit = (unit: GenerationUnit): string => unit.memberIds[unit.memberIds.length - 1] ?? unit.leaderId

    const unitsByVoice = new Map<string, GenerationUnit[]>()
    for (const unit of units) unitsByVoice.set(unit.voiceId, [...(unitsByVoice.get(unit.voiceId) ?? []), unit])

    const fallbackVoice = VOICE_MODELS.find((v) => v.id === 'male-adult')
    const fallbackControlPrompt = fallbackVoice?.controlPrompt
    const groups: DubbingGenerationGroup[] = []
    for (const [voiceId, voiceUnits] of unitsByVoice) {
      const voice = VOICE_MODELS.find((v) => v.id === voiceId)
      const groupSegments = voiceUnits.map((unit) => ({
        segmentId: unit.leaderId,
        text: unit.text,
        startTime: unit.startTime,
        endTime: unit.endTime,
        // The take may run until the line after its LAST line starts.
        nextSegmentStartTime: nextStartById.get(lastLineOfUnit(unit)),
        pitch: unit.pitch,
        speed: unit.speed,
        volumeDb: unit.volumeDb,
        // The take's performance travels with it to the main process, which
        // turns it into this line's own control, seed, scoring profile and
        // loudness (app/main/ipc/dubbing.ts).
        performance: unit.performance,
        lineKey: unit.leaderId,
        takeNonce: unit.takeNonce,
        innerVoice: unit.innerVoice
      }))
      // A named voice the user recorded (see savedVoices.ts). It has no
      // catalog entry and no control prompt -- it IS its reference clip, so
      // it groups exactly like Custom Voice does. Without this it would fall
      // to the `else` below and be dubbed in Male Adult's fallback voice.
      const saved = findSavedVoice(savedVoices, voiceId)
      if (saved) {
        groups.push({ voiceId, referenceAudioPath: saved.referenceAudioPath, promptText: saved.name, segments: groupSegments })
      } else if (voiceId === 'custom-voice') {
        // Only the recording is required. This used to also demand
        // `customVoiceReferenceText` -- and silently fell through to the
        // `else` below when it was blank, where 'custom-voice' has no
        // controlPrompt of its own and so picked up `fallbackControlPrompt`
        // (Male Adult's). Choosing Custom Voice, picking your recording, and
        // not filling in the optional "what does it say" box therefore
        // generated a stock male voice with no error anywhere: Custom Voice
        // looked completely dead. The text was never even sent to the model
        // (see buildBatchArgs -- the CLI rejects --prompt-text without
        // --prompt-audio), so it could never have been required.
        groups.push({
          voiceId,
          referenceAudioPath: state.customVoiceReferenceAudioPath,
          promptText: state.customVoiceReferenceText,
          segments: groupSegments
        })
      } else {
        // Both engines' settings travel with every group -- the main process
        // uses whichever the request's own engine calls for.
        groups.push({
          voiceId,
          control: voice?.controlPrompt ?? fallbackControlPrompt,
          voiceDescription: voice?.identity ?? fallbackVoice?.identity,
          edgeVoice: voice?.edgeVoice,
          kiriVoice: kiriVoiceOf(voiceId),
          segments: groupSegments
        })
      }
    }

    const leaderOf = new Map(units.flatMap((unit) => unit.memberIds.map((memberId) => [memberId, unit.leaderId] as const)))
    setState((prev) => {
      const next = { ...prev.segments }
      for (const seg of speakableSegments) {
        next[seg.id] = { ...(next[seg.id] ?? defaultDubbingSegmentState(seg.id)), status: 'generating', joinedInto: leaderOf.get(seg.id) }
      }
      // Keep the performances the local analysis just filled in, so the UI
      // shows (and a later run reuses) exactly what was generated.
      for (const [id, perf] of Object.entries(filled)) {
        const existing = next[id] ?? defaultDubbingSegmentState(id)
        if (!existing.performance) next[id] = { ...existing, performance: perf }
      }
      // Progress counts takes -- one result arrives per take, not per line.
      return { ...prev, segments: next, generationProgress: { completed: 0, total: units.length }, generationError: undefined, generationNote }
    })

    void window.api.dubbing.generateBatch({ engine: settings.engine, installDir: settings.installDir, device: settings.device, pitchMatch: settings.pitchMatch, tone: settings.tone, steadyPace: settings.steadyPace, kiriActing: settings.kiriActing, groups })
  }, [segments, state.speakers, state.customVoiceReferenceAudioPath, state.customVoiceReferenceText])

  const generateDubbing = useCallback(() => runGeneration(undefined, state.segments), [runGeneration, state.segments])

  const regenerateSegment = useCallback(
    (segmentId: string) => {
      // A new take number -> a new performance seed for this take.
      const ids = expandToTakes([segmentId], state.segments)
      const bumped = { ...state.segments }
      for (const id of ids) {
        const existing = bumped[id] ?? defaultDubbingSegmentState(id)
        bumped[id] = { ...existing, takeNonce: (existing.takeNonce ?? 0) + 1 }
      }
      setState((prev) => {
        const next = { ...prev.segments }
        for (const id of ids) next[id] = { ...(next[id] ?? defaultDubbingSegmentState(id)), takeNonce: bumped[id].takeNonce }
        return { ...prev, segments: next }
      })
      runGeneration([segmentId], bumped)
    },
    [runGeneration, state.segments]
  )

  const generateSegmentWith = useCallback(
    (segmentId: string, engine: DubbingEngine, voiceId?: string) => {
      // A new take of this line, in this engine (and voice, when given).
      const ids = expandToTakes([segmentId], state.segments)
      const voice = voiceId ? { voiceId, voiceManuallyAssigned: true } : {}
      const bumped = { ...state.segments }
      for (const id of ids) {
        const existing = bumped[id] ?? defaultDubbingSegmentState(id)
        bumped[id] = { ...existing, takeNonce: (existing.takeNonce ?? 0) + 1, ...(id === segmentId ? voice : {}) }
      }
      setState((prev) => {
        const next = { ...prev.segments }
        for (const id of ids) next[id] = { ...(next[id] ?? defaultDubbingSegmentState(id)), takeNonce: bumped[id].takeNonce, ...(id === segmentId ? voice : {}) }
        return { ...prev, segments: next }
      })
      runGeneration([segmentId], bumped, engine)
    },
    [runGeneration, state.segments]
  )

  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null)

  const detectEmotions = useCallback(
    async (segmentIds?: string[]): Promise<void> => {
      if (segments.length === 0) return
      const all = buildPerformanceInput(segments, state.segments, state.speakers)
      const forced = segmentIds ? new Set(segmentIds) : null
      const targets = forced ? all.filter((line) => forced.has(line.id)) : all.filter((line) => state.segments[line.id]?.performance?.analysisSource !== 'manual')
      if (targets.length === 0) {
        setAnalysisMessage('Every line has a performance set by hand -- use Auto Detect on a line to replace its own.')
        return
      }
      // Gemini needs the targets and the lines around them, not the whole script.
      const indexById = new Map(all.map((line, i) => [line.id, i]))
      const keep = new Set<number>()
      for (const target of targets) {
        const i = indexById.get(target.id) ?? 0
        for (let j = Math.max(0, i - CONTEXT_WINDOW_LINES); j <= Math.min(all.length - 1, i + CONTEXT_WINDOW_LINES); j++) keep.add(j)
      }
      const lines = [...keep].sort((a, b) => a - b).map((i) => all[i])
      setAnalysisRunning(true)
      setAnalysisMessage(null)
      let performances: Record<string, LinePerformance>
      let message: string
      try {
        const result = await window.api.dubbing.analyzePerformance(`dub-perf-${Date.now()}`, lines)
        if (result.ok) {
          performances = result.performances
          message = `Emotions detected by ${result.model} for ${targets.length} line${targets.length === 1 ? '' : 's'}, each read with the lines around it.`
        } else {
          performances = analyzePerformancesByRules(all)
          message = `Gemini could not analyse the lines (${result.error}) -- used the local analysis instead (emotion tags like (យំ), punctuation, neighbouring lines).`
        }
      } catch (err) {
        performances = analyzePerformancesByRules(all)
        message = `Gemini could not analyse the lines (${err instanceof Error ? err.message : String(err)}) -- used the local analysis instead.`
      } finally {
        setAnalysisRunning(false)
      }
      const targetIds = targets.map((line) => line.id)
      setState((prev) => {
        const next = { ...prev.segments }
        for (const id of targetIds) {
          const perf = performances[id]
          if (!perf) continue
          const existing = next[id] ?? defaultDubbingSegmentState(id)
          // A line set by hand while this ran keeps the hand-set value.
          if (!forced && existing.performance?.analysisSource === 'manual') continue
          next[id] = { ...existing, performance: perf }
        }
        return { ...prev, segments: next }
      })
      setAnalysisMessage(message)
    },
    [segments, state.segments, state.speakers]
  )

  const setSegmentPerformance = useCallback((segmentId: string, patch: Partial<LinePerformance>) => {
    setState((prev) => {
      const existing = prev.segments[segmentId] ?? defaultDubbingSegmentState(segmentId)
      const base = existing.performance ?? neutralPerformance('manual')
      const merged = sanitizePerformance({ ...base, ...patch }, 'manual')
      if (!merged) return prev
      return { ...prev, segments: { ...prev.segments, [segmentId]: { ...existing, performance: merged } } }
    })
  }, [])

  const resetSegmentPerformance = useCallback((segmentId: string) => {
    setState((prev) => {
      const existing = prev.segments[segmentId]
      if (!existing?.performance) return prev
      const { performance: _performance, ...rest } = existing
      return { ...prev, segments: { ...prev.segments, [segmentId]: rest } }
    })
  }, [])

  const dismissAnalysisMessage = useCallback(() => setAnalysisMessage(null), [])

  const setSegmentInnerVoice = useCallback((segmentId: string, on: boolean) => {
    setState((prev) => ({
      ...prev,
      segments: { ...prev.segments, [segmentId]: { ...(prev.segments[segmentId] ?? defaultDubbingSegmentState(segmentId)), innerVoice: on, innerVoiceSource: 'manual' } }
    }))
  }, [])

  const isInnerVoice = useCallback(
    (segmentId: string): boolean => {
      const segment = segments.find((seg) => seg.id === segmentId)
      return segment ? effectiveInnerVoice(state.segments[segmentId], segment) : false
    },
    [segments, state.segments]
  )

  const [innerVoiceRunning, setInnerVoiceRunning] = useState(false)

  const detectInnerVoices = useCallback(async () => {
    const lines = segmentsRef.current
    if (lines.length === 0) return
    setInnerVoiceRunning(true)
    setAnalysisMessage(null)
    try {
      // Every line's own video and its time in that video: the clip under
      // it on the Timeline (one video, or a Batch Load run of episodes).
      const parts = batchPartsOf(sequenceRef.current)
      const byMedia = new Map<string, { id: string; startTime: number; endTime: number }[]>()
      for (const seg of lines) {
        const part = parts.find((p) => seg.startTime >= p.startTime && seg.startTime < p.endTime)
        if (!part) continue
        const toFile = (t: number): number => part.sourceIn + (t - part.startTime) * part.rate
        byMedia.set(part.mediaId, [...(byMedia.get(part.mediaId) ?? []), { id: seg.id, startTime: toFile(seg.startTime), endTime: toFile(seg.endTime) }])
      }
      const echoScore = new Map<string, number>()
      for (const [mediaId, mediaLines] of byMedia) {
        const originalPath = itemsRef.current.find((m) => m.id === mediaId)?.originalPath
        if (!originalPath) continue
        for (const { id, score } of await window.api.dubbing.detectEchoLines({ originalPath, lines: mediaLines })) echoScore.set(id, score)
      }
      // Decided here, from the current state -- not inside the setState
      // updater, which React may run later (the message below needs the
      // counts now).
      let fromEcho = 0
      let fromText = 0
      let fromGemini = 0
      let kept = 0
      const decided = new Map<string, { innerVoice: boolean; innerVoiceSource: DubbingSegmentState['innerVoiceSource'] }>()
      for (const seg of lines) {
        const st = stateRef.current.segments[seg.id]
        if (st?.innerVoiceSource === 'manual') {
          if (st.innerVoice) kept++
          continue
        }
        const echo = (echoScore.get(seg.id) ?? 0) >= ECHO_SCORE_THRESHOLD
        const text = innerVoiceFromText(seg.editedText ?? seg.text)
        if (seg.innerVoice) fromGemini++
        else if (text) fromText++
        else if (echo) fromEcho++
        // Detection is re-run from scratch for every line not set by hand.
        decided.set(seg.id, { innerVoice: echo || text, innerVoiceSource: echo ? 'echo' : text ? 'text' : undefined })
      }
      setState((prev) => {
        const next = { ...prev.segments }
        for (const [id, verdict] of decided) {
          const st = next[id] ?? defaultDubbingSegmentState(id)
          // Set by hand while this ran: that stands.
          if (st.innerVoiceSource === 'manual') continue
          next[id] = { ...st, ...verdict }
        }
        return { ...prev, segments: next }
      })
      const total = fromEcho + fromText + fromGemini + kept
      const parts2 = [
        fromEcho > 0 ? `${fromEcho} by the echo in the audio` : '',
        fromText > 0 ? `${fromText} by the subtitle text` : '',
        fromGemini > 0 ? `${fromGemini} marked by Gemini` : '',
        kept > 0 ? `${kept} set by hand` : ''
      ].filter(Boolean)
      setAnalysisMessage(
        total > 0
          ? `💭 ${total} inner-voice line${total === 1 ? '' : 's'} (${parts2.join(', ')}) -- dubbed with an echo. Click 💭 on a line to change it.`
          : '💭 No inner-voice lines found. Mark one by hand with its 💭 button.'
      )
    } catch (err) {
      setAnalysisMessage(`Inner-voice detection failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInnerVoiceRunning(false)
    }
  }, [])

  /** Stops a running Generate Dubbing. Takes already made (being imported or
   * waiting their turn on the Timeline) still land; every other line goes
   * back to how it was before the run -- not failed, just not made -- so
   * Generate Dubbing can be pressed again straight away. */
  const cancelGeneration = useCallback(() => {
    generationCanceledRef.current = true
    void window.api.dubbing.cancelGeneration()
    const madeLeaders = new Set([...readyForPlacementRef.current.keys(), ...[...pendingAcceptsRef.current.values()].map((pending) => pending.segmentId)])
    const madeLines = new Set([...madeLeaders].flatMap((leaderId) => [leaderId, ...(joinedMembersRef.current.get(leaderId) ?? [])]))
    const unmade = segmentsRef.current.filter((seg) => stateRef.current.segments[seg.id]?.status === 'generating' && !madeLines.has(seg.id)).map((seg) => seg.id)
    // The placement queue steps over them, so the made takes after them
    // are not left waiting for lines that will never come.
    for (const id of unmade) failedSegmentIdsRef.current.add(id)
    setState((prev) => {
      const next = { ...prev.segments }
      for (const id of unmade) {
        const line = next[id]
        if (line) next[id] = { ...line, status: line.voiceId ? 'voice-assigned' : 'pending', joinedInto: undefined }
      }
      // No message: the button turning back into Generate Dubbing says it.
      // Any error from the canceled run goes with it.
      return { ...prev, segments: next, generationProgress: undefined, generationError: undefined, generationNote: undefined }
    })
    tryDrainPlacementQueue()
  }, [tryDrainPlacementQueue])

  const dismissGenerationMessage = useCallback((kind: 'error' | 'note') => {
    setState((prev) => (kind === 'error' ? { ...prev, generationError: undefined } : { ...prev, generationNote: undefined }))
  }, [])

  // Real per-line results push from the main process as VoxCPM2 finishes
  // each subtitle (see app/main/ipc/dubbing.ts) -- registered once for the
  // whole provider lifetime, not per generateDubbing() call, since a batch
  // can genuinely still be running when this component tree re-renders for
  // unrelated reasons. A 'generated' event reuses the EXACT SAME pending-
  // ref-plus-items-effect pattern the old placeholder path already used
  // (see the effect just below) -- only WHERE the audio file came from
  // changed, not how it lands on DUB1 once imported.
  useEffect(() => {
    const unsubscribe = window.api.dubbing.onGenerationProgress((event) => {
      // A tagged batch belongs to someone else (Recap narration) -- not
      // one of these segments, not this progress counter.
      if (event.batchId) return
      // Canceled: whatever the engine was finishing is not wanted any more.
      if (generationCanceledRef.current) return
      setState((prev) => ({
        ...prev,
        generationProgress: prev.generationProgress
          ? { completed: Math.min(prev.generationProgress.completed + 1, prev.generationProgress.total), total: prev.generationProgress.total }
          : prev.generationProgress
      }))

      if (event.status === 'failed' || !event.outputPath) {
        // A failed take fails every line it was reading.
        const failedIds = [event.segmentId, ...(joinedMembersRef.current.get(event.segmentId) ?? [])]
        setState((prev) => {
          const next = { ...prev.segments }
          for (const id of failedIds) next[id] = { ...(next[id] ?? defaultDubbingSegmentState(id)), status: 'needs-review' }
          return { ...prev, segments: next }
        })
        // Keep the FIRST real reason a run failed (later segments usually
        // repeat the same one) so the panel can actually show it, instead
        // of every failure being an unexplained 'needs-review'.
        if (event.error) setState((prev) => (prev.generationError ? prev : { ...prev, generationError: event.error }))
        // This segment will never produce a clip -- let the placement
        // cursor skip over it instead of waiting forever for one (a failure
        // can be exactly what was blocking chronologically-later segments
        // that are already sitting in readyForPlacementRef).
        failedSegmentIdsRef.current.add(event.segmentId)
        tryDrainPlacementQueue()
        return
      }

      const seg = segmentsRef.current.find((s) => s.id === event.segmentId)
      if (!seg) return
      if (event.debug) {
        // The take's debug record belongs to every line it read.
        const ids = [event.segmentId, ...(joinedMembersRef.current.get(event.segmentId) ?? [])]
        const debug = event.debug
        setState((prev) => {
          const next = { ...prev.segments }
          for (const id of ids) next[id] = { ...(next[id] ?? defaultDubbingSegmentState(id)), debug }
          return { ...prev, segments: next }
        })
      }
      const existing = stateRef.current.segments[event.segmentId]
      const clipId = crypto.randomUUID()
      pendingAcceptsRef.current.set(event.outputPath, { segmentId: event.segmentId, startTime: seg.startTime, clipId, previousClipId: existing?.generatedClipId })
      void importPaths([event.outputPath])
    })
    return unsubscribe
  }, [importPaths, tryDrainPlacementQueue])

  // Once a generated (or placeholder) clip comes back 'ready' through the
  // normal import pipeline, it's NOT placed onto DUB1 immediately -- moved
  // into readyForPlacementRef instead, since its correct start time depends
  // on its chronological predecessor already being placed (see
  // tryDrainPlacementQueue's own doc comment for why). Draining every
  // still-in-flight generation that's ready this pass (Generate Dubbing
  // kicks off every subtitle, across however many voice groups,
  // essentially at once), same pending-ref-plus-effect pattern as
  // NarrationContext.tsx otherwise.
  useEffect(() => {
    if (pendingAcceptsRef.current.size === 0) return
    for (const [path, pending] of pendingAcceptsRef.current) {
      const match = items.find((item) => item.originalPath === path)
      if (!match || (match.stage !== 'ready' && match.stage !== 'error')) continue
      pendingAcceptsRef.current.delete(path)
      if (match.stage === 'error') {
        const failedIds = [pending.segmentId, ...(joinedMembersRef.current.get(pending.segmentId) ?? [])]
        setState((prev) => {
          const next = { ...prev.segments }
          for (const id of failedIds) next[id] = { ...(next[id] ?? defaultDubbingSegmentState(id)), status: 'needs-review' }
          return { ...prev, segments: next }
        })
        failedSegmentIdsRef.current.add(pending.segmentId)
        continue
      }

      readyForPlacementRef.current.set(pending.segmentId, { mediaItem: match, clipId: pending.clipId, previousClipId: pending.previousClipId })
    }
    tryDrainPlacementQueue()
  }, [items, tryDrainPlacementQueue])

  const restore = useCallback((saved: DubbingWorkspaceState) => {
    // Projects saved before messages stopped being saved still carry the
    // last run's error/note -- dropped here so an old one never reappears.
    // A saved performance is re-validated (a hand-edited or damaged project
    // must not reach the prompt builder); projects from before performances
    // simply have none, and get one at their next Generate.
    const segmentsWithValidPerformance = sanitizeSegmentPerformances(saved.segments)
    setState(withoutTransientDubbingState({ ...saved, segments: segmentsWithValidPerformance, speakers: saved.speakers ?? {} }))
  }, [])

  // "Remove SRT" -- clears the loaded video/SRT/segment bookkeeping and
  // returns to the Add Video/Add SRT setup screen (AiDubberScriptPanel
  // branches on `state.videoMediaId` being unset), without leaving AI
  // Dubber mode entirely. Never touches `transcripts` itself -- the parsed
  // segments simply stop being referenced once `videoMediaId` is cleared,
  // same as how nothing here ever duplicated that data in the first place.
  // Any already-generated DUB1 clips on the Timeline are untouched too;
  // this only clears the WORKSPACE's own state, not the project's sequence.
  /** Every subtitle that currently has a generated clip on the Timeline,
   * paired with that clip and the room available before the next subtitle
   * starts -- the shared input both Auto-Sync and Auto-Speed work from. */
  const generatedClipPairs = useCallback(() => {
    const pairs: { segment: TranscriptSegment; clip: TimelineClip; availableSeconds: number }[] = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      // A line read inside a neighbour's take shares that take's clip; the
      // take is paired once, through its first line.
      if (state.segments[seg.id]?.joinedInto) continue
      const clipId = state.segments[seg.id]?.generatedClipId
      if (!clipId) continue
      const clip = sequence.clips.find((c) => c.id === clipId)
      if (!clip) continue
      // The take's room runs until the line after its LAST covered line.
      let last = i
      while (last + 1 < segments.length && state.segments[segments[last + 1].id]?.joinedInto === seg.id) last++
      const nextStart = segments[last + 1]?.startTime
      const availableSeconds = Math.max(0.1, (nextStart ?? segments[last].endTime) - seg.startTime)
      pairs.push({ segment: seg, clip, availableSeconds })
    }
    return pairs
  }, [segments, state.segments, sequence.clips])

  const autoSyncDubClips = useCallback((): number => {
    // On its subtitle's start, but never over the line before it.
    const updates = planAutoSync(generatedClipPairs().map(({ segment, clip }) => ({ clipId: clip.id, subtitleStart: segment.startTime, clipStart: clip.startTime, clipSeconds: clip.duration })))
    if (updates.length > 0) setClipStartTimes(updates)
    return updates.length
  }, [generatedClipPairs, setClipStartTimes])

  const [autoSpeedRunning, setAutoSpeedRunning] = useState(false)

  const videoOverlay = useMemo(() => sanitizeVideoOverlaySettings(state.videoOverlay), [state.videoOverlay])
  const setVideoOverlay = useCallback((update: (current: VideoOverlaySettings) => VideoOverlaySettings) => {
    setState((prev) => ({ ...prev, videoOverlay: sanitizeVideoOverlaySettings(update(sanitizeVideoOverlaySettings(prev.videoOverlay))) }))
  }, [])
  const overlayLines = useMemo<OverlayLine[]>(() => segments.map((s) => ({ start: s.startTime, end: s.endTime, text: s.editedText ?? s.text })), [segments])
  const [overlayEditing, setOverlayEditing] = useState(false)

  /** Each Video Sync's Timeline before/after with the subtitles of each:
   * Undo/Redo restore only the Timeline, so the subtitles are put back to
   * match whenever the Timeline is exactly one of these again. */
  const videoSyncLinksRef = useRef<{ mediaId: string; before: ProjectSequence; after: ProjectSequence; beforeTranscript: Transcript; afterTranscript: Transcript }[]>([])

  const videoSyncDubClips = useCallback((): { lines: number; addedSeconds: number; stillLong: number } => {
    const mediaId = stateRef.current.videoMediaId
    const transcript = mediaId ? transcripts[mediaId] : undefined
    if (!mediaId || !transcript) return { lines: 0, addedSeconds: 0, stillLong: 0 }
    const mainTrackId = getMainVideoTrackId(sequence.tracks)
    // Read just inside the line: at its exact start the clip before can
    // still "contain" it by a float hair.
    const videoRateAt = (time: number): number => {
      const at = time + 0.01
      const picture = sequence.clips.find((c) => c.type === 'video' && c.trackId === mainTrackId && c.startTime <= at && at < c.startTime + c.duration)
      return picture ? clipRate(picture) : 1
    }
    const lines = generatedClipPairs().map(({ segment, clip, availableSeconds }) => ({ start: segment.startTime, room: availableSeconds, clipSeconds: clip.duration, videoRate: videoRateAt(segment.startTime) }))
    const regions = planVideoSync(lines)
    // Still longer than their room once slowed as far as allowed: those run a little late.
    const stillLong = lines.filter((line) => {
      const region = regions.find((r) => Math.abs(r.start - line.start) < 1e-6)
      return line.clipSeconds > (region ? (region.end - region.start) / region.rate : line.room) + 0.02
    }).length
    if (regions.length === 0) return { lines: 0, addedSeconds: 0, stillLong }
    const byId = new Map(sequence.clips.map((c) => [c.id, c]))
    // The picture, its own sound, and the music bed Remove Vocals made --
    // everything that has to stay with the picture. Dubbed lines, added
    // music and text only move.
    const stretch = (clip: TimelineClip): boolean => {
      if (clip.trackId === DUBBING_TRACK_ID) return false
      if (clip.type === 'video') return true
      if (clip.type !== 'audio') return false
      if (clip.linkedClipId && byId.get(clip.linkedClipId)?.type === 'video') return true
      return /no-vocals/i.test(itemsRef.current.find((m) => m.id === clip.mediaId)?.originalPath ?? '')
    }
    const before = sequence
    const after = applyVideoSync(before, regions, stretch)
    const afterTranscript: Transcript = { ...transcript, segments: retimeSegmentsForVideoSync(transcript.segments, regions) }
    videoSyncLinksRef.current = [...videoSyncLinksRef.current.slice(-19), { mediaId, before, after, beforeTranscript: transcript, afterTranscript }]
    restoreSequence(after)
    setImportedTranscript(mediaId, afterTranscript)
    return { lines: regions.length, addedSeconds: videoSyncAddedSeconds(regions), stillLong }
  }, [transcripts, sequence, generatedClipPairs, restoreSequence, setImportedTranscript])

  useEffect(() => {
    for (const link of videoSyncLinksRef.current) {
      const current = transcripts[link.mediaId]
      if (sequence === link.before && current === link.afterTranscript) setImportedTranscript(link.mediaId, link.beforeTranscript)
      else if (sequence === link.after && current === link.beforeTranscript) setImportedTranscript(link.mediaId, link.afterTranscript)
    }
    // Only a Timeline change (Undo/Redo) re-checks; transcripts are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequence])

  const autoSpeedDubClips = useCallback(async (): Promise<number> => {
    const overlong = generatedClipPairs().filter(({ clip, availableSeconds }) => clip.duration > availableSeconds + 0.01)
    if (overlong.length === 0) {
      autoSyncDubClips()
      return 0
    }
    setAutoSpeedRunning(true)
    let refitted = 0
    try {
      for (const { clip, availableSeconds } of overlong) {
        const media = itemsRef.current.find((m) => m.id === clip.mediaId)
        if (!media?.originalPath) continue
        // At most AUTO_SPEED_MAX, and only once per line (a re-fitted file's
        // name carries ".refit-"): speeding without limit is what made the
        // voice unclear. What still does not fit runs late (Auto-Sync).
        const speed = autoSpeedFor(clip.duration, availableSeconds, /\.refit-/.test(media.originalPath))
        if (speed === null) continue
        const result = await window.api.dubbing.refitClipAudio(`refit-${clip.id}-${Date.now()}`, media.originalPath, speed)
        if (!result.ok) continue
        await importPaths([result.outputPath])
        refitClipTargetsRef.current.set(result.outputPath, clip.id)
        refitted++
      }
    } finally {
      setAutoSpeedRunning(false)
    }
    return refitted
    // Media read through the ref: depending on `items` rebuilt this -- and
    // the whole context -- on every import/proxy progress tick.
  }, [generatedClipPairs, autoSyncDubClips, importPaths])

  /** Re-fitted audio waiting on its import round-trip, keyed by output path
   * -- same pending-ref-then-items-effect pattern as the generation path. */
  const refitClipTargetsRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (refitClipTargetsRef.current.size === 0) return
    let placedAny = false
    for (const [path, clipId] of refitClipTargetsRef.current) {
      const match = items.find((item) => item.originalPath === path)
      if (!match || (match.stage !== 'ready' && match.stage !== 'error')) continue
      refitClipTargetsRef.current.delete(path)
      if (match.stage === 'error') continue
      replaceClipMedia(clipId, match.id, match.metadata?.durationSeconds ?? 0)
      placedAny = true
    }
    // Re-align once the shortened clips are in place, so Auto-Speed always
    // leaves the Timeline synced rather than needing a second button press.
    if (placedAny) autoSyncDubClips()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` should retrigger this; the sequence mutators are stable context callbacks.
  }, [items])

  const clearWorkspace = useCallback(() => {
    // The subtitles leave the Timeline too: its caption track draws the
    // open video's transcript, so keeping it left every line on screen
    // after Remove SRT.
    const videoMediaId = stateRef.current.videoMediaId
    if (videoMediaId) removeTranscript(videoMediaId)
    // A series stays: the episode whose SRT was removed goes back to
    // waiting, and the Timeline stays that episode's.
    setState((prev) => ({
      ...createDefaultDubbingWorkspaceState(),
      active: true,
      // The look of the subtitles and the blur boxes belong to the series.
      videoOverlay: prev.videoOverlay,
      episodes: prev.episodes?.map((e) => (e.mediaId === prev.videoMediaId ? { ...e, status: 'waiting' as const, workspace: undefined, error: undefined } : e)),
      timelineEpisodeId: prev.episodes?.length ? (prev.timelineEpisodeId ?? prev.videoMediaId) : undefined
    }))
    setPendingVideoId(null)
  }, [removeTranscript])

  const clearBatchVideos = useCallback(() => {
    const live = sequenceRef.current
    const videoIds = new Set(batchPartsOf(live).map((part) => part.clipId))
    // The dub made for these subtitles goes with them.
    const dubIds = live.clips.filter((c) => c.trackId.startsWith('DUB')).map((c) => c.id)
    if (videoIds.size > 0 || dubIds.length > 0) deleteClipsById([...videoIds, ...dubIds])
    clearWorkspace()
    setBatchErrors({})
    setBatchUnclear({})
    setBatchMessage(null)
  }, [deleteClipsById, clearWorkspace])

  // ---- Series mode -------------------------------------------------------

  const episodes = useMemo(() => state.episodes ?? [], [state.episodes])
  const episodeSwitchBlocked = autoSpeedRunning || Object.values(state.segments).some((s) => s.status === 'generating')
  const episodeSwitchBlockedRef = useRef(episodeSwitchBlocked)
  episodeSwitchBlockedRef.current = episodeSwitchBlocked

  const updateEpisode = useCallback((mediaId: string, patch: Partial<DubbingEpisode>) => {
    setState((prev) => ({ ...prev, episodes: prev.episodes?.map((e) => (e.mediaId === mediaId ? { ...e, ...patch } : e)) }))
  }, [])

  const addEpisodes = useCallback((mediaIds: string[]) => {
    const cur = stateRef.current
    const videos = mediaIds
      .map((id) => itemsRef.current.find((m) => m.id === id))
      .filter((m): m is MediaItem => !!m && m.kind === 'video')
      .map((m) => ({ mediaId: m.id, fileName: m.fileName }))
    // The video already open joins the series first -- its Timeline and
    // setup have to be parked somewhere when another episode opens.
    const open = cur.videoMediaId ? itemsRef.current.find((m) => m.id === cur.videoMediaId) : undefined
    const all = open ? [{ mediaId: open.id, fileName: open.fileName }, ...videos] : videos
    if (all.length === 0) return
    setState((prev) => {
      const next = withEpisodesAdded(prev.episodes ?? [], all)
      if (next === prev.episodes) return prev
      // Videos that already have subtitles here need no Auto SRT.
      const withStatus = next.map((e) =>
        e.status === 'waiting' && (e.mediaId === prev.videoMediaId || (transcriptsRef.current[e.mediaId]?.segments.length ?? 0) > 0) ? { ...e, status: 'done' as const } : e
      )
      return { ...prev, episodes: withStatus, timelineEpisodeId: prev.timelineEpisodeId ?? prev.videoMediaId }
    })
  }, [])

  const removeEpisode = useCallback((mediaId: string) => {
    setState((prev) => {
      // The open episode, or the one the Timeline belongs to, stays.
      if (mediaId === prev.videoMediaId || mediaId === prev.timelineEpisodeId) return prev
      return { ...prev, episodes: prev.episodes?.filter((e) => e.mediaId !== mediaId) }
    })
  }, [])

  const openEpisode = useCallback(
    (mediaId: string) => {
      const cur = stateRef.current
      if (cur.videoMediaId === mediaId || episodeSwitchBlockedRef.current) return
      // Any imported video: a listed episode, or a single video added on
      // the Add Video screen (it opens on the Timeline with no subtitles
      // yet, ready for Add SRT / Auto SRT / Translate).
      if (!itemsRef.current.some((m) => m.id === mediaId && m.kind === 'video')) return
      const parkEpisodes = bringTimelineTo(mediaId, cur)
      // Built on the latest state: an Auto SRT that just finished for this
      // episode has put its setup in the list in this same tick.
      setState((prev) => {
        let parked = parkEpisodes(prev) ?? prev.episodes ?? []
        // Same Timeline (it already was this episode's), but another
        // episode's setup was open: park that setup.
        if (prev.videoMediaId && prev.videoMediaId !== mediaId && !parked.find((e) => e.mediaId === prev.videoMediaId)?.workspace) {
          parked = parked.map((e) => (e.mediaId === prev.videoMediaId ? { ...e, workspace: episodeWorkspaceOf(prev) } : e))
        }
        const workspace = sanitizeEpisodeWorkspace(parked.find((e) => e.mediaId === mediaId)?.workspace)
        const episodesAfter = parked.map((e) => (e.mediaId === mediaId ? { ...e, workspace: undefined, sequence: undefined } : e))
        return { ...withEpisodeOpen(prev, mediaId, workspace), episodes: episodesAfter, timelineEpisodeId: mediaId }
      })
      selectMedia(mediaId)
      setSelectedSubtitleId(null)
      setPendingVideoId(null)
      seekTo(0)
    },
    [bringTimelineTo, selectMedia, seekTo]
  )
  const openEpisodeRef = useRef(openEpisode)
  openEpisodeRef.current = openEpisode

  const [episodeJob, setEpisodeJob] = useState<{ mediaId: string; percent: number; message: string } | null>(null)
  const [episodeMessage, setEpisodeMessage] = useState<string | null>(null)
  const episodeJobIdRef = useRef<string | null>(null)
  const episodeRunningRef = useRef(false)
  const episodeCanceledRef = useRef(false)

  useEffect(
    () =>
      window.api.transcription.onDetectSpeakersProgress((progress) => {
        if (progress.jobId !== episodeJobIdRef.current) return
        setEpisodeJob((job) => (job ? { ...job, percent: progress.percent, message: progress.message } : job))
      }),
    []
  )

  /** A finished Auto SRT: the subtitles go to the episode's transcript; the
   * setup to the live workspace if it is the open episode, else to the list. */
  const applyEpisodeTranscript = useCallback(
    (mediaId: string, result: DetectSpeakersResult) => {
      setImportedTranscript(mediaId, result.transcript)
      const episode = stateRef.current.episodes?.find((e) => e.mediaId === mediaId)
      const workspace = { ...detectedEpisodeWorkspace(result), srtFileName: episodeSrtFileName(episode?.fileName ?? result.srtFileName) }
      if (stateRef.current.videoMediaId === mediaId) {
        setState((prev) => ({ ...prev, ...workspace, episodes: prev.episodes?.map((e) => (e.mediaId === mediaId ? { ...e, status: 'done' as const, error: undefined } : e)) }))
      } else {
        updateEpisode(mediaId, { status: 'done', error: undefined, workspace })
      }
    },
    [setImportedTranscript, updateEpisode]
  )

  const transcribeEpisodes = useCallback(async (onlyMediaIds?: string[]) => {
    if (episodeRunningRef.current) return
    episodeRunningRef.current = true
    episodeCanceledRef.current = false
    setEpisodeMessage(null)
    let finished = 0
    let failed = 0
    let lastError: string | undefined
    let stoppedBecause: string | undefined
    try {
      for (const mediaId of onlyMediaIds ?? episodesToTranscribe(stateRef.current.episodes ?? [])) {
        if (episodeCanceledRef.current) break
        // Nine videos picked at once are still importing when this starts:
        // wait for this one (a few minutes at most) rather than fail it.
        const readyBy = Date.now() + 180_000
        while (!episodeCanceledRef.current && Date.now() < readyBy && !itemsRef.current.find((m) => m.id === mediaId)?.readyToUse) {
          setEpisodeJob({ mediaId, percent: 0, message: 'Waiting for the video to finish importing…' })
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        if (episodeCanceledRef.current) break
        const item = itemsRef.current.find((m) => m.id === mediaId)
        if (!item?.originalPath || !item.readyToUse) {
          updateEpisode(mediaId, { status: 'failed', error: 'This video is not ready yet (still importing) -- try again in a moment.' })
          failed++
          continue
        }
        const jobId = `ai-dubber-episode-${mediaId}-${Date.now()}`
        episodeJobIdRef.current = jobId
        setEpisodeJob({ mediaId, percent: 0, message: 'Preparing Gemini Auto SRT…' })
        updateEpisode(mediaId, { status: 'transcribing', error: undefined })
        try {
          const result = await window.api.transcription.detectSpeakers({
            jobId,
            mediaId,
            originalPath: item.originalPath,
            modelId: transcribeSettingsRef.current.selectedModelId,
            language: transcribeSettingsRef.current.language,
            voxCpmInstallDir: storedVoxCpmInstallDir()
          })
          applyEpisodeTranscript(mediaId, result)
          finished++
          lastError = undefined
          // Nothing open yet: start on the first finished episode while the
          // rest keep transcribing.
          if (!stateRef.current.videoMediaId) openEpisodeRef.current(mediaId)
        } catch (caught) {
          if (episodeCanceledRef.current) {
            updateEpisode(mediaId, { status: 'waiting' })
            break
          }
          const raw = caught instanceof Error ? caught.message : String(caught)
          // Electron's "Error invoking remote method …" wrapper says nothing useful.
          const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
          updateEpisode(mediaId, { status: 'failed', error: message })
          failed++
          if (isSeriesWideFailure(lastError, message)) {
            stoppedBecause = message
            break
          }
          lastError = message
        }
      }
    } finally {
      episodeJobIdRef.current = null
      episodeRunningRef.current = false
      setEpisodeJob(null)
      const canceled = episodeCanceledRef.current
      const parts = [`Auto SRT ${canceled ? 'stopped' : 'finished'}: ${finished} video${finished === 1 ? '' : 's'} transcribed`]
      if (failed > 0) parts.push(`${failed} failed`)
      let text = parts.join(', ') + '.'
      if (stoppedBecause) text += ` Stopped early -- every episode was failing the same way: ${stoppedBecause}`
      setEpisodeMessage(text)
    }
  }, [updateEpisode, applyEpisodeTranscript])

  // ---- Batch Auto SRT (shared/dubbingBatch.ts) ---------------------------

  const batchParts = useMemo(() => batchPartsOf(sequence), [sequence])
  const [batchJob, setBatchJob] = useState<{ clipId: string; percent: number; message: string } | null>(null)
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({})
  const [batchMessage, setBatchMessage] = useState<string | null>(null)
  const [batchUnclear, setBatchUnclear] = useState<Record<string, number>>({})
  const batchJobIdRef = useRef<string | null>(null)
  const batchRunningRef = useRef(false)
  const batchCanceledRef = useRef(false)
  /** Videos picked by Batch Load, placed end to end as they finish importing
   * -- in name order, each waiting for the one before it. */
  const pendingBatchRef = useRef<{ paths: string[]; done: Set<string>; cursor: number | null; transcribe: boolean } | null>(null)
  const [batchTick, setBatchTick] = useState(0)
  const [batchTranscribeQueued, setBatchTranscribeQueued] = useState(false)

  useEffect(
    () =>
      window.api.transcription.onDetectSpeakersProgress((progress) => {
        if (progress.jobId !== batchJobIdRef.current) return
        setBatchJob((job) => (job ? { ...job, percent: progress.percent, message: progress.message } : job))
      }),
    []
  )

  const startBatchLoad = useCallback(
    async (paths: string[], transcribe: boolean) => {
      if (paths.length === 0) return
      const fresh = paths.filter((path) => !itemsRef.current.some((m) => m.originalPath === path))
      if (fresh.length > 0) await importPaths(fresh)
      const name = (path: string): string => path.split(/[\\/]/).pop() ?? path
      pendingBatchRef.current = { paths: [...paths].sort((a, b) => compareEpisodeNames(name(a), name(b))), done: new Set(), cursor: null, transcribe }
      setBatchMessage(null)
      setBatchTick((t) => t + 1)
    },
    [importPaths]
  )

  const batchLoadVideos = useCallback(
    async (transcribe: boolean) => {
      const paths = await window.api.media.pickFiles()
      await startBatchLoad(paths, transcribe)
    },
    [startBatchLoad]
  )

  useEffect(() => {
    const job = pendingBatchRef.current
    if (!job) return
    const live = sequenceRef.current
    const mainId = getMainVideoTrackId(live.tracks) ?? live.tracks.find((t) => t.kind === 'video')?.id
    if (!mainId) return
    // After whatever is on the main track already.
    let cursor = job.cursor ?? live.clips.filter((c) => c.trackId === mainId).reduce((end, c) => Math.max(end, c.startTime + c.duration), 0)
    let firstPlaced: string | undefined
    for (const path of job.paths) {
      if (job.done.has(path)) continue
      const media = items.find((m) => m.originalPath === path)
      if (!media) break
      if (media.stage === 'error' || media.kind !== 'video') {
        job.done.add(path)
        continue
      }
      if (!media.readyToUse) break
      insertClip(assetFromMediaItem(media), cursor, mainId)
      cursor += media.metadata?.durationSeconds ?? 0
      job.done.add(path)
      firstPlaced ??= media.id
    }
    job.cursor = cursor
    if (firstPlaced) {
      prepareDubbingTrack()
      const opened = firstPlaced
      // Nothing open yet: the workspace opens on the first video (its
      // transcript will hold every episode's lines, in Timeline time).
      if (!stateRef.current.videoMediaId) {
        setState((prev) => (prev.videoMediaId ? prev : { ...prev, active: true, videoMediaId: opened }))
        selectMedia(opened)
        setPendingVideoId(null)
      }
    }
    if (job.done.size === job.paths.length) {
      pendingBatchRef.current = null
      if (job.transcribe) setBatchTranscribeQueued(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs as imports land; the callbacks it uses are stable.
  }, [items, batchTick])

  /** Lines currently under a Timeline clip. */
  const linesUnder = useCallback((part: BatchPart): number => segments.filter((seg) => seg.startTime >= part.startTime && seg.startTime < part.endTime).length, [segments])

  /** One video's Auto SRT result, placed under its clip in the workspace. */
  const applyPartTranscript = useCallback(
    (part: BatchPart, label: string, result: DetectSpeakersResult, fromSrt?: string) => {
      const placed = placePartTranscript(part, label, result.transcript.segments, result.speakers)
      const holder = stateRef.current.videoMediaId ?? part.mediaId
      const current = transcriptsRef.current[holder]?.segments ?? []
      const merged = mergePartSegments(current, part, placed.segments)
      const transcript: Transcript = {
        mediaId: holder,
        segments: merged,
        requestedLanguage: result.transcript.requestedLanguage,
        detectedLanguage: result.transcript.detectedLanguage,
        generatedAt: new Date().toISOString(),
        audioSourcePath: '',
        source: fromSrt ? 'srt' : 'speaker-detection'
      }
      setImportedTranscript(holder, transcript)
      // The next video in this run reads it before a render.
      transcriptsRef.current = { ...transcriptsRef.current, [holder]: transcript }
      setState((prev) => {
        const keep = new Set(merged.map((seg) => seg.id))
        const nextSegments: DubbingWorkspaceState['segments'] = {}
        for (const [id, line] of Object.entries(prev.segments)) if (keep.has(id)) nextSegments[id] = line
        for (const seg of placed.segments) nextSegments[seg.id] = { ...defaultDubbingSegmentState(seg.id), speakerId: seg.speakerId }
        const speakers: DubbingWorkspaceState['speakers'] = {}
        for (const [id, speaker] of Object.entries(prev.speakers)) if (!id.startsWith(`${part.clipId}:`)) speakers[id] = speaker
        for (const speaker of placed.speakers) speakers[speaker.id] = speaker as DubbingSpeakerProfile
        return { ...prev, active: true, videoMediaId: holder, srtFileName: fromSrt ?? prev.srtFileName ?? 'Auto SRT (Gemini)', segments: nextSegments, speakers }
      })
      selectMedia(holder)
      return placed.segments.length
    },
    [setImportedTranscript, selectMedia]
  )

  const transcribeBatch = useCallback(
    async (onlyClipIds?: string[]) => {
      if (batchRunningRef.current) return
      batchRunningRef.current = true
      batchCanceledRef.current = false
      setBatchMessage(null)
      let finished = 0
      let failed = 0
      let lastError: string | undefined
      let stoppedBecause: string | undefined
      try {
        const order = batchPartsOf(sequenceRef.current)
        const holderSegments = (): TranscriptSegment[] => {
          const holder = stateRef.current.videoMediaId
          return holder ? (transcriptsRef.current[holder]?.segments ?? []) : []
        }
        const todo = onlyClipIds ?? order.filter((part) => !holderSegments().some((seg) => seg.startTime >= part.startTime && seg.startTime < part.endTime)).map((part) => part.clipId)
        // One Gemini run per video FILE: Video Sync cuts one film into many
        // clips, and every clip used to send the whole file to Gemini again
        // (thirty clips, thirty transcriptions of the same film). The first
        // clip's result is placed under each of the others.
        const resultByMedia = new Map<string, DetectSpeakersResult>()
        for (const clipId of todo) {
          if (batchCanceledRef.current) break
          // Re-read every time: the Timeline may have moved meanwhile.
          const parts = batchPartsOf(sequenceRef.current)
          const index = parts.findIndex((part) => part.clipId === clipId)
          const part = parts[index]
          const media = part ? itemsRef.current.find((m) => m.id === part.mediaId) : undefined
          if (!part || !media?.originalPath) continue
          const jobId = `ai-dubber-batch-${clipId}-${Date.now()}`
          batchJobIdRef.current = jobId
          setBatchJob({ clipId, percent: 0, message: `Video ${index + 1} of ${parts.length}: preparing Gemini Auto SRT…` })
          setBatchErrors((prev) => {
            const { [clipId]: _gone, ...rest } = prev
            return rest
          })
          try {
            const result =
              resultByMedia.get(part.mediaId) ??
              (await window.api.transcription.detectSpeakers({
                jobId,
                mediaId: part.mediaId,
                originalPath: media.originalPath,
                modelId: transcribeSettingsRef.current.selectedModelId,
                language: transcribeSettingsRef.current.language,
                voxCpmInstallDir: storedVoxCpmInstallDir()
              }))
            resultByMedia.set(part.mediaId, result)
            // Where the clip is NOW (it can be moved while Gemini works).
            const now = batchPartsOf(sequenceRef.current).find((p) => p.clipId === clipId) ?? part
            // Speakers are named by the episode number in the file name
            // ("… EP10.mp4" -> EP10), else by position on the Timeline.
            const episodeNo = /(?:ep|episode|ភាគ)\s*\.?\s*(\d+)/i.exec(media.fileName)?.[1]
            // Numbered by video, not by clip: every piece of one film is "Video 1".
            const videoNo = [...new Set(parts.map((p) => p.mediaId))].indexOf(part.mediaId) + 1
            applyPartTranscript(now, episodeNo ? `EP${episodeNo}` : `Video ${videoNo}`, result)
            setBatchUnclear((prev) => ({ ...prev, [clipId]: result.unclearSeconds ?? 0 }))
            finished++
            lastError = undefined
          } catch (caught) {
            if (batchCanceledRef.current) break
            const raw = caught instanceof Error ? caught.message : String(caught)
            const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
            setBatchErrors((prev) => ({ ...prev, [clipId]: message }))
            failed++
            if (isSeriesWideFailure(lastError, message)) {
              stoppedBecause = message
              break
            }
            lastError = message
          }
        }
      } finally {
        batchJobIdRef.current = null
        batchRunningRef.current = false
        setBatchJob(null)
        let text = `Auto SRT ${batchCanceledRef.current ? 'stopped' : 'finished'}: ${finished} video${finished === 1 ? '' : 's'} transcribed${failed > 0 ? `, ${failed} failed` : ''}.`
        if (stoppedBecause) text += ` Stopped early -- every video was failing the same way: ${stoppedBecause}`
        // Say where lines may be missing, instead of leaving it to be found
        // on the Timeline.
        const holder = stateRef.current.videoMediaId
        const lines = holder ? (transcriptsRef.current[holder]?.segments ?? []) : []
        const withGaps = batchPartsOf(sequenceRef.current).filter((part) => lines.some((l) => l.startTime >= part.startTime && l.startTime < part.endTime) && findGaps(part, lines).length > 0).length
        if (withGaps > 0) text += ` ⚠ ${withGaps} video${withGaps === 1 ? ' has' : 's have'} stretches with no lines -- check them, or press Fill gaps.`
        setBatchMessage(text)
      }
    },
    [applyPartTranscript]
  )

  // Batch Load with "transcribe as they load": starts once every video is on
  // the Timeline (so each one's position is final).
  useEffect(() => {
    if (!batchTranscribeQueued) return
    setBatchTranscribeQueued(false)
    void transcribeBatch()
  }, [batchTranscribeQueued, sequence, transcribeBatch])

  const fillBatchGaps = useCallback(
    async (clipId: string) => {
      if (batchRunningRef.current) return
      const parts = batchPartsOf(sequenceRef.current)
      const index = parts.findIndex((p) => p.clipId === clipId)
      const part = parts[index]
      const media = part ? itemsRef.current.find((m) => m.id === part.mediaId) : undefined
      if (!part || !media?.originalPath) return
      const holder = stateRef.current.videoMediaId ?? part.mediaId
      const current = transcriptsRef.current[holder]?.segments ?? []
      const gaps = findGaps(part, current)
      if (gaps.length === 0) {
        setBatchMessage('No stretches without lines in this video.')
        return
      }
      batchRunningRef.current = true
      batchCanceledRef.current = false
      setBatchMessage(null)
      const jobId = `ai-dubber-gaps-${clipId}-${Date.now()}`
      batchJobIdRef.current = jobId
      setBatchJob({ clipId, percent: 0, message: `Sending ${gaps.length} stretch${gaps.length === 1 ? '' : 'es'} with no lines back to Gemini…` })
      try {
        const result = await window.api.transcription.detectSpeakers({
          jobId,
          mediaId: part.mediaId,
          originalPath: media.originalPath,
          modelId: transcribeSettingsRef.current.selectedModelId,
          language: transcribeSettingsRef.current.language,
          voxCpmInstallDir: storedVoxCpmInstallDir(),
          ranges: gaps.map((g) => ({ start: g.fileStart, end: g.fileEnd }))
        })
        // Own ids and speakers for this pass: its "Speaker 1" is not the
        // first pass's "Speaker 1".
        const episodeNo = /(?:ep|episode|ភាគ)\s*\.?\s*(\d+)/i.exec(media.fileName)?.[1]
        const label = `${episodeNo ? `EP${episodeNo}` : `Video ${index + 1}`} (gap)`
        const placed = placePartTranscript({ ...part, clipId: `${clipId}-gap${Date.now().toString(36)}` }, label, result.transcript.segments, result.speakers)
        const latest = transcriptsRef.current[holder]
        const merged = mergeGapLines(latest?.segments ?? [], gaps, placed.segments)
        const added = merged.length - (latest?.segments.length ?? 0)
        const transcript: Transcript = {
          mediaId: holder,
          segments: merged,
          requestedLanguage: latest?.requestedLanguage ?? result.transcript.requestedLanguage,
          detectedLanguage: latest?.detectedLanguage ?? result.transcript.detectedLanguage,
          generatedAt: new Date().toISOString(),
          audioSourcePath: latest?.audioSourcePath ?? '',
          source: latest?.source ?? 'speaker-detection'
        }
        setImportedTranscript(holder, transcript)
        transcriptsRef.current = { ...transcriptsRef.current, [holder]: transcript }
        const addedIds = new Set(merged.map((l) => l.id))
        setState((prev) => {
          const nextSegments = { ...prev.segments }
          for (const seg of placed.segments) if (addedIds.has(seg.id)) nextSegments[seg.id] = { ...defaultDubbingSegmentState(seg.id), speakerId: seg.speakerId }
          const speakers = { ...prev.speakers }
          for (const speaker of placed.speakers) if (speaker.segmentIds.some((id) => addedIds.has(id))) speakers[speaker.id] = speaker as DubbingSpeakerProfile
          return { ...prev, active: true, videoMediaId: holder, segments: nextSegments, speakers }
        })
        setBatchUnclear((prev) => ({ ...prev, [clipId]: result.unclearSeconds ?? 0 }))
        setBatchMessage(
          added > 0
            ? `Fill gaps: ${added} line${added === 1 ? '' : 's'} found in ${gaps.length} stretch${gaps.length === 1 ? '' : 'es'} and added.`
            : `Fill gaps: Gemini found no speech in ${gaps.length === 1 ? 'that stretch' : `those ${gaps.length} stretches`} -- most likely music or silence.`
        )
      } catch (caught) {
        const raw = caught instanceof Error ? caught.message : String(caught)
        if (!batchCanceledRef.current) setBatchMessage(`Fill gaps failed: ${raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')}`)
      } finally {
        batchJobIdRef.current = null
        batchRunningRef.current = false
        setBatchJob(null)
      }
    },
    [setImportedTranscript]
  )

  const cancelBatch = useCallback(() => {
    batchCanceledRef.current = true
    const jobId = batchJobIdRef.current
    if (jobId) void window.api.transcription.cancelDetectSpeakers(jobId)
  }, [])

  const saveBatchSrts = useCallback(async () => {
    const holder = stateRef.current.videoMediaId
    const all = holder ? (transcriptsRef.current[holder]?.segments ?? []) : []
    const files = batchPartsOf(sequenceRef.current)
      .map((part) => ({ part, lines: partLocalSegments(all, part) }))
      .filter(({ lines }) => lines.length > 0)
      .map(({ part, lines }) => ({ fileName: episodeSrtFileName(itemsRef.current.find((m) => m.id === part.mediaId)?.fileName ?? part.clipId), srtText: transcriptSegmentsToSrt(lines) }))
    if (files.length === 0) {
      setBatchMessage('No video has subtitles yet -- run Auto SRT first.')
      return
    }
    try {
      const saved = await window.api.dubbing.saveEpisodeSrts(files)
      if (saved) setBatchMessage(`Saved ${saved.written} SRT file${saved.written === 1 ? '' : 's'} to ${saved.folder}`)
    } catch (err) {
      setBatchMessage(`Could not save the SRT files: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  // File names only: `items` itself changes on every import/proxy progress
  // tick, and each change rebuilt the rows -- and with them the whole AI
  // Dubber context, re-rendering thousands of subtitle rows while idle.
  const mediaNamesKey = items.map((m) => `${m.id}\u0000${m.fileName}`).join('\u0001')
  const fileNameById = useMemo(() => new Map(items.map((m) => [m.id, m.fileName])), [mediaNamesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const batchRows = useMemo(
    () =>
      batchParts.map((part) => {
        const lines = linesUnder(part)
        const status: 'waiting' | 'transcribing' | 'done' | 'failed' =
          batchJob?.clipId === part.clipId ? 'transcribing' : batchErrors[part.clipId] ? 'failed' : lines > 0 ? 'done' : 'waiting'
        const gaps = lines > 0 ? findGaps(part, segments) : []
        return { ...part, fileName: fileNameById.get(part.mediaId) ?? part.mediaId, lines, status, error: batchErrors[part.clipId], gaps, unclearSeconds: batchUnclear[part.clipId] }
      }),
    [batchParts, linesUnder, batchJob, batchErrors, fileNameById, segments, batchUnclear]
  )

  /** Add Video: the file dialog, then -- as the files land in the media
   * list (imports are asynchronous) -- straight onto the Timeline. One
   * video opens by itself (with the SRT picked before it, if any); two or
   * more become episodes and the first opens. Watched here, not by the Add
   * Video screen, which closes as soon as the first video opens. */
  const pendingBatchSrtsRef = useRef<{ path: string; srt: { fileName: string; srtText: string } }[]>([])

  /** One SRT (times in its video's own file) placed under that video's clip
   * on the Timeline -- replaces the lines already under it. */
  const applySrtToPart = useCallback(
    (part: BatchPart, index: number, srt: { fileName: string; srtText: string }): number => {
      const { srtText } = splitDubbingSrt(srt.srtText)
      const { segments: cues } = parseSrtToSegments(srtText)
      if (cues.length === 0) return 0
      const media = itemsRef.current.find((m) => m.id === part.mediaId)
      const episodeNo = media ? /(?:ep|episode|ភាគ)\s*\.?\s*(\d+)/i.exec(media.fileName)?.[1] : undefined
      const transcript: Transcript = { mediaId: part.mediaId, segments: cues, requestedLanguage: 'auto', generatedAt: new Date().toISOString(), audioSourcePath: '', source: 'srt' }
      const result: DetectSpeakersResult = { transcript, speakers: [], srtText, srtPath: '', srtFileName: srt.fileName }
      prepareDubbingTrack()
      return applyPartTranscript(part, episodeNo ? `EP${episodeNo}` : `Video ${index + 1}`, result, batchPartsOf(sequenceRef.current).length >= 2 ? 'SRT per video' : srt.fileName)
    },
    [applyPartTranscript, prepareDubbingTrack]
  )

  const addSrtFiles = useCallback(
    (files: { fileName: string; srtText: string }[]): SrtPlacement => {
      const parts = batchPartsOf(sequenceRef.current)
      const names = parts.map((part, i) => itemsRef.current.find((m) => m.id === part.mediaId)?.fileName ?? `Video ${i + 1}`)
      const pairs = pairSrtsWithVideos(names, files.map((f) => f.fileName))
      const placed: SrtPlacement['placed'] = []
      const unmatched: string[] = []
      files.forEach((file, i) => {
        const index = pairs[i]
        if (index === null) unmatched.push(file.fileName)
        else placed.push({ srt: file.fileName, video: names[index], lines: applySrtToPart(parts[index], index, file) })
      })
      return { placed, unmatched }
    },
    [applySrtToPart]
  )

  const pendingImportRef = useRef<{ paths: string[]; series: boolean; opened: boolean } | null>(null)
  const pendingSrtRef = useRef<{ srtText: string; srtFileName: string } | null>(null)
  const [importTick, setImportTick] = useState(0)

  const importVideos = useCallback(async (): Promise<{ srtFileName?: string; srtWaiting: boolean }> => {
    const picked = await window.api.dubbing.pickVideosAndSrt()
    const cur = stateRef.current
    const srts = picked.srts ?? (picked.srt ? [picked.srt] : [])
    const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path
    const partCount = batchPartsOf(sequenceRef.current).length
    // SRTs only, with videos already on the Timeline: several SRTs (or one
    // among several videos) each go under their own video, matched by name.
    if (srts.length > 0 && picked.videoPaths.length === 0 && partCount > 0 && (srts.length >= 2 || partCount >= 2)) {
      setBatchMessage(srtPlacementMessage(addSrtFiles(srts)))
      return { srtFileName: srts.length === 1 ? srts[0].fileName : `${srts.length} SRT files`, srtWaiting: false }
    }
    // Several videos with their SRTs: Batch Load, then each SRT under its
    // video as that video lands on the Timeline.
    if (srts.length > 0 && picked.videoPaths.length >= 2 && (cur.episodes?.length ?? 0) === 0) {
      const pairs = pairSrtsWithVideos(picked.videoPaths.map(fileName), srts.map((s) => s.fileName))
      pendingBatchSrtsRef.current = srts.flatMap((srt, i) => (pairs[i] !== null ? [{ path: picked.videoPaths[pairs[i] as number], srt }] : []))
      const unmatched = srts.filter((_, i) => pairs[i] === null).map((s) => s.fileName)
      setBatchMessage(unmatched.length > 0 ? `No video for ${unmatched.join(', ')} -- add its video too.` : null)
      await startBatchLoad(picked.videoPaths, false)
      return { srtFileName: `${srts.length} SRT files`, srtWaiting: false }
    }
    // One video with several SRTs: the one whose name matches it.
    if (srts.length >= 2 && picked.videoPaths.length === 1) {
      const pair = pairSrtsWithVideos([fileName(picked.videoPaths[0])], srts.map((s) => s.fileName))
      picked.srt = srts[pair.findIndex((v) => v === 0)] ?? srts[0]
    }
    if (picked.srt) {
      const srt = { srtText: picked.srt.srtText, srtFileName: picked.srt.fileName }
      // Only an SRT: it belongs to the open video -- or, with none open,
      // the first video already on the Timeline. Straight onto the Timeline.
      const target = cur.videoMediaId ?? batchPartsOf(sequenceRef.current)[0]?.mediaId
      if (picked.videoPaths.length === 0 && target) {
        prepareWorkspace({ videoMediaId: target, ...srt })
        return { srtFileName: srt.srtFileName, srtWaiting: false }
      }
      // Otherwise it goes to the first video this brings in (or the next
      // one added, when none came with it).
      pendingSrtRef.current = srt
    }
    const paths = picked.videoPaths
    if (paths.length === 0) return { srtFileName: picked.srt?.fileName, srtWaiting: !!picked.srt }
    // Several videos: end to end on the Timeline in episode order (Batch
    // Load), not separate episodes.
    if (paths.length >= 2 && (cur.episodes?.length ?? 0) === 0) {
      await startBatchLoad(paths, false)
      return { srtFileName: picked.srt?.fileName, srtWaiting: false }
    }
    // A video already in Media is reused, not imported a second time.
    const fresh = paths.filter((path) => !itemsRef.current.some((m) => m.originalPath === path))
    if (fresh.length > 0) await importPaths(fresh)
    const name = (path: string): string => path.split(/[\\/]/).pop() ?? path
    pendingImportRef.current = {
      paths: [...paths].sort((a, b) => compareEpisodeNames(name(a), name(b))),
      series: paths.length >= 2 || (cur.episodes?.length ?? 0) > 0,
      // Adding episodes while one is being dubbed leaves that one open.
      opened: !!cur.videoMediaId
    }
    setImportTick((t) => t + 1)
    return { srtFileName: picked.srt?.fileName, srtWaiting: false }
  }, [importPaths, prepareWorkspace, startBatchLoad, addSrtFiles])

  // SRTs picked together with several videos: each placed under its video
  // once that video is on the Timeline (Batch Load places them as their
  // imports finish).
  useEffect(() => {
    const pending = pendingBatchSrtsRef.current
    if (pending.length === 0) return
    const parts = batchPartsOf(sequenceRef.current)
    const placed: SrtPlacement['placed'] = []
    pendingBatchSrtsRef.current = pending.filter(({ path, srt }) => {
      const media = items.find((m) => m.originalPath === path)
      const index = media ? parts.findIndex((p) => p.mediaId === media.id) : -1
      if (!media || index < 0) return media?.stage !== 'error'
      placed.push({ srt: srt.fileName, video: media.fileName, lines: applySrtToPart(parts[index], index, srt) })
      return false
    })
    if (placed.length > 0) setBatchMessage((prev) => [prev, srtPlacementMessage({ placed, unmatched: [] })].filter(Boolean).join(' '))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs as the Timeline fills; the callbacks it uses are stable.
  }, [batchParts, items])

  const dismissBatchMessage = useCallback(() => setBatchMessage(null), [])

  const setPendingSrt = useCallback((srt: { srtText: string; srtFileName: string } | null) => {
    pendingSrtRef.current = srt
  }, [])

  useEffect(() => {
    const job = pendingImportRef.current
    if (!job) return
    const landed = job.paths.map((path) => items.find((m) => m.originalPath === path))
    const videos = landed.filter((m): m is MediaItem => !!m && m.kind === 'video')
    if (job.series && videos.length > 0) addEpisodes(videos.map((m) => m.id))
    if (!job.opened) {
      // The first file in name order that is a usable video -- waiting for
      // it rather than jumping ahead to whichever finished importing first.
      for (const media of landed) {
        if (!media) break
        if (media.kind !== 'video' || media.stage === 'error') continue
        if (!media.readyToUse) break
        job.opened = true
        const srt = pendingSrtRef.current
        if (srt) {
          pendingSrtRef.current = null
          prepareWorkspace({ videoMediaId: media.id, srtText: srt.srtText, srtFileName: srt.srtFileName })
        } else {
          openEpisodeRef.current(media.id)
        }
        break
      }
    }
    if (job.opened && landed.every(Boolean)) pendingImportRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs as imports land; the callbacks it uses are stable.
  }, [items, importTick])

  const cancelEpisodeTranscription = useCallback(() => {
    episodeCanceledRef.current = true
    const jobId = episodeJobIdRef.current
    if (jobId) void window.api.transcription.cancelDetectSpeakers(jobId)
  }, [])

  const saveEpisodeSrts = useCallback(async () => {
    const files = (stateRef.current.episodes ?? [])
      .map((e) => ({ episode: e, segments: transcriptsRef.current[e.mediaId]?.segments ?? [] }))
      .filter(({ segments: lines }) => lines.length > 0)
      .map(({ episode, segments: lines }) => ({ fileName: episodeSrtFileName(episode.fileName), srtText: transcriptSegmentsToSrt(lines) }))
    if (files.length === 0) {
      setEpisodeMessage('No episode has subtitles yet -- run Auto SRT first.')
      return
    }
    try {
      const saved = await window.api.dubbing.saveEpisodeSrts(files)
      if (saved) setEpisodeMessage(`Saved ${saved.written} SRT file${saved.written === 1 ? '' : 's'} to ${saved.folder}`)
    } catch (err) {
      setEpisodeMessage(`Could not save the SRT files: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const dismissEpisodeMessage = useCallback(() => setEpisodeMessage(null), [])

  const value = useMemo<AiDubberContextValue>(
    () => ({
      state,
      active: state.active,
      segments,
      getSegmentState,
      selectedSubtitleId,
      setSelectedSubtitleId,
      pendingVideoId,
      setPendingVideoId,
      enterAiDubber,
      exitAiDubber,
      prepareWorkspace,
      prepareDetectedWorkspace,
      updateSegmentText,
      updateSegmentTiming,
      addSubtitle,
      addSubtitleAt,
      moveSubtitle,
      moveSubtitles,
      removeSubtitle,
      removeSubtitles,
      setSegmentVoice,
      setAllSegmentsVoice,
      setSegmentAgeGroup,
      setSegmentIsNarrator,
      setSegmentControl,
      renameSpeaker,
      setSpeakerGender,
      setSpeakerAge,
      setSpeakerVoice,
      mergeSpeakers,
      splitSpeaker,
      setCustomVoiceReferenceAudio,
      setCustomVoiceReferenceText,
      detectGenderForSegment,
      sourceOfLine,
      generateDubbing,
      detectEmotions,
      analysisRunning,
      analysisMessage,
      dismissAnalysisMessage,
      setSegmentPerformance,
      resetSegmentPerformance,
      setSegmentInnerVoice,
      isInnerVoice,
      detectInnerVoices,
      innerVoiceRunning,
      regenerateSegment,
      generateSegmentWith,
      cancelGeneration,
      dismissGenerationMessage,
      restore,
      clearWorkspace,
      autoSyncDubClips,
      autoSpeedDubClips,
      autoSpeedRunning,
      videoSyncDubClips,
      videoOverlay,
      setVideoOverlay,
      overlayLines,
      overlayEditing,
      setOverlayEditing,
      episodes,
      addEpisodes,
      removeEpisode,
      openEpisode,
      transcribeEpisodes,
      cancelEpisodeTranscription,
      episodeJob,
      episodeMessage,
      dismissEpisodeMessage,
      saveEpisodeSrts,
      episodeSwitchBlocked,
      importVideos,
      setPendingSrt,
      batchRows,
      batchLoadVideos,
      transcribeBatch,
      addSrtFiles,
      cancelBatch,
      batchJob,
      batchMessage,
      dismissBatchMessage,
      saveBatchSrts,
      clearBatchVideos,
      fillBatchGaps
    }),
    [
      state,
      segments,
      getSegmentState,
      selectedSubtitleId,
      pendingVideoId,
      enterAiDubber,
      exitAiDubber,
      prepareWorkspace,
      prepareDetectedWorkspace,
      updateSegmentText,
      updateSegmentTiming,
      addSubtitle,
      addSubtitleAt,
      moveSubtitle,
      moveSubtitles,
      removeSubtitle,
      removeSubtitles,
      setSegmentVoice,
      setAllSegmentsVoice,
      setSegmentAgeGroup,
      setSegmentIsNarrator,
      setSegmentControl,
      renameSpeaker,
      setSpeakerGender,
      setSpeakerAge,
      setSpeakerVoice,
      mergeSpeakers,
      splitSpeaker,
      setCustomVoiceReferenceAudio,
      setCustomVoiceReferenceText,
      detectGenderForSegment,
      sourceOfLine,
      generateDubbing,
      detectEmotions,
      analysisRunning,
      analysisMessage,
      dismissAnalysisMessage,
      setSegmentPerformance,
      resetSegmentPerformance,
      setSegmentInnerVoice,
      isInnerVoice,
      detectInnerVoices,
      innerVoiceRunning,
      regenerateSegment,
      generateSegmentWith,
      cancelGeneration,
      dismissGenerationMessage,
      restore,
      clearWorkspace,
      autoSyncDubClips,
      autoSpeedDubClips,
      autoSpeedRunning,
      videoSyncDubClips,
      videoOverlay,
      setVideoOverlay,
      overlayLines,
      overlayEditing,
      setOverlayEditing,
      episodes,
      addEpisodes,
      removeEpisode,
      openEpisode,
      transcribeEpisodes,
      cancelEpisodeTranscription,
      episodeJob,
      episodeMessage,
      dismissEpisodeMessage,
      saveEpisodeSrts,
      episodeSwitchBlocked,
      importVideos,
      setPendingSrt,
      batchRows,
      batchLoadVideos,
      transcribeBatch,
      addSrtFiles,
      cancelBatch,
      batchJob,
      batchMessage,
      dismissBatchMessage,
      saveBatchSrts,
      clearBatchVideos,
      fillBatchGaps
    ]
  )

  return <AiDubberContext.Provider value={value}>{children}</AiDubberContext.Provider>
}

export function useAiDubber(): AiDubberContextValue {
  const ctx = useContext(AiDubberContext)
  if (!ctx) throw new Error('useAiDubber must be used within AiDubberProvider')
  return ctx
}
