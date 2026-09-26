import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DetectSpeakersResult, SpeakerAgeCategory, SpeakerGender, TranscriptSegment, Transcript } from '@shared/transcription'
import type { MediaItem } from '@shared/media'
import type { TimelineClip } from '@shared/project'
import { parseSrtToSegments } from '@shared/srt'
import { restoreDubbingWorkspace, splitDubbingSrt } from '@shared/dubbingSrt'
import {
  createDefaultDubbingWorkspaceState,
  defaultDubbingSegmentState,
  withoutTransientDubbingState,
  type DubbingWorkspaceState,
  type DubbingSegmentState,
  type DubbingSpeakerProfile,
  type NarrationSpeaker
} from '@shared/dubbing'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useSequence } from '../sequence/SequenceContext'
import { usePlaybackTime } from '../playback/PlaybackContext'
import { useHistory } from '../history/HistoryContext'
import { useUiState, type LeftView, type RightTab } from '../nav/UiStateContext'
import { DUBBING_TRACK_ID, findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { findSavedVoice, isSavedVoiceId, loadSavedVoices, loadStoryNarratorVoiceId } from './savedVoices'
import { VOICE_MODELS, recommendVoiceId, edgeFallbackVoiceId } from './voiceModels'
import { cleanTextForSpeech, hasSpeakableText } from './ttsTextCleaning'
import { planGenerationUnits, resolveLineVoice, type GenerationUnit, type PlannedLine } from './dubbingPlan'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from './voxcpmSettings'
import type { DubbingGenerationGroup } from '@shared/dubbing'

export interface PrepareDubbingResult {
  segmentCount: number
  warnings: string[]
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
  detectGenderForSegment: (segment: TranscriptSegment) => Promise<NarrationSpeaker>

  /** "Generate Dubbing" -- real VoxCPM2 text-to-speech (see
   * app/main/media/voxcpmTts.ts), grouped per assigned voice. Per-line
   * results stream via window.api.dubbing.onGenerationProgress, not this
   * function's own return value. */
  generateDubbing: () => void
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
   * before the next subtitle so it fits exactly, then re-syncs. Unlike
   * generation's own 1.28x ceiling this has no cap: the user asked for these
   * lines to fit, so fitting wins over the "keep it natural" default. */
  autoSpeedDubClips: () => Promise<number>
  /** True while an Auto-Speed pass is re-rendering audio. */
  autoSpeedRunning: boolean
}

const AiDubberContext = createContext<AiDubberContextValue | null>(null)

const DEFAULT_NEW_SUBTITLE_DURATION = 2

export function AiDubberProvider({ children }: { children: ReactNode }): JSX.Element {
  const { items, importPaths, select: selectMedia } = useMedia()
  const { transcripts, setImportedTranscript, updateSegmentText: updateTranscriptSegmentText, moveSegment, moveSegments } = useTranscript()
  const { sequence, insertClip, ensureTrack, prepareDubbingTrack, acceptDubbingClip, setClipStartTimes, replaceClipMedia, deleteClipsById } = useSequence()
  const { beginTransaction, endTransaction } = useHistory()
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

      // Spans two contexts (transcript + sequence) as one logical step, so it
      // collapses into one Undo entry -- same beginTransaction/endTransaction
      // pattern as NarrationContext.prepareWorkspace.
      beginTransaction()
      setImportedTranscript(params.videoMediaId, transcript)
      selectMedia(params.videoMediaId)
      prepareDubbingTrack()
      // AI Dubber's own "Add Video" is a standalone entry point (unlike
      // Story Narration, which assumes a project already has a video on the
      // Timeline) -- without this, the imported video only ever lived in the
      // Media panel/preview selection, never actually on the Timeline, so
      // there was nothing to preview alongside the generated dub clips or
      // export a real dubbed video from. Idempotent: skips insertion if this
      // exact media is already on the Timeline (e.g. Add SRT called again
      // for a video added earlier).
      const videoItem = items.find((m) => m.id === params.videoMediaId)
      const alreadyOnTimeline = sequence.clips.some((c) => c.mediaId === params.videoMediaId)
      if (videoItem && !alreadyOnTimeline) {
        const duration = videoItem.metadata?.durationSeconds ?? 0
        const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
        const routing = findOrCreateTrack(sequence.tracks, occupied, 0, duration, 'video')
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
      }
      endTransaction()

      // Recap Script's My Voice choice (savedVoices.ts's story narrator)
      // becomes every line's voice from the start -- marked as a manual
      // pick so gender detection never swaps it out. Only if that voice
      // still exists; a deleted one just leaves lines on auto.
      // (A restored SRT keeps its own voices instead.)
      const narratorVoiceId = loadStoryNarratorVoiceId()
      const narratorExists = narratorVoiceId ? !!findSavedVoice(loadSavedVoices(), narratorVoiceId) : false
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
        genderDetectionStatus: restored && Object.values(restored.segments).some((s) => s.detectedGender !== 'unknown') ? 'detected' : 'idle'
      }))
      setPendingVideoId(null)

      const issueWarnings = issues.map((i) => `Segment ${i.blockIndex + 1}: ${i.reason}`)
      if (restored?.mismatch) {
        issueWarnings.push(`This SRT's saved voice setup was for ${dubbingData!.lines.length} lines but it now has ${cues.length} -- lines were matched in order; check the voices.`)
      }
      return { segmentCount: parsedSegments.length, warnings: issueWarnings }
    },
    [beginTransaction, endTransaction, setImportedTranscript, selectMedia, prepareDubbingTrack, items, sequence, insertClip, ensureTrack]
  )

  const prepareDetectedWorkspace = useCallback(
    (params: { videoMediaId: string; result: DetectSpeakersResult }): PrepareDubbingResult => {
      const transcript = params.result.transcript
      beginTransaction()
      setImportedTranscript(params.videoMediaId, transcript)
      selectMedia(params.videoMediaId)
      prepareDubbingTrack()
      const videoItem = items.find((media) => media.id === params.videoMediaId)
      const alreadyOnTimeline = sequence.clips.some((clip) => clip.mediaId === params.videoMediaId)
      if (videoItem && !alreadyOnTimeline) {
        const duration = videoItem.metadata?.durationSeconds ?? 0
        const occupied: OccupiedRange[] = sequence.clips.map((clip) => ({ trackId: clip.trackId, startTime: clip.startTime, endTime: clip.startTime + clip.duration }))
        const routing = findOrCreateTrack(sequence.tracks, occupied, 0, duration, 'video')
        if (routing.newTrack) ensureTrack(routing.newTrack)
        insertClip(assetFromMediaItem(videoItem), 0, routing.trackId)
      }
      endTransaction()

      const speakers = Object.fromEntries(params.result.speakers.map((speaker) => [speaker.id, speaker as DubbingSpeakerProfile]))
      const initialSegments: DubbingWorkspaceState['segments'] = {}
      for (const segment of transcript.segments) {
        initialSegments[segment.id] = {
          ...defaultDubbingSegmentState(segment.id),
          speakerId: segment.speakerId,
          // Auto SRT separates recurring voices only. It does not enter the
          // old Detect Gender workflow or auto-pick a voice from gender/age.
          detectedGender: 'unknown'
        }
      }
      setState((previous) => ({
        ...previous,
        active: true,
        videoMediaId: params.videoMediaId,
        srtFileName: params.result.srtFileName,
        generatedSrtPath: params.result.srtPath,
        genderDetectionStatus: 'idle',
        segments: initialSegments,
        speakers
      }))
      setPendingVideoId(null)
      return { segmentCount: transcript.segments.length, warnings: [] }
    },
    [beginTransaction, endTransaction, setImportedTranscript, selectMedia, prepareDubbingTrack, items, sequence, insertClip, ensureTrack]
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
  const detectGenderForSegment = useCallback(
    async (segment: TranscriptSegment): Promise<NarrationSpeaker> => {
      if (!videoOriginalPath) return 'unknown'
      try {
        const result = await window.api.narration.detectSpeaker(`dub-gender-${segment.id}`, videoOriginalPath, segment.startTime, segment.endTime)
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
          const voiceId = existing.voiceManuallyAssigned ? existing.voiceId : (recommendVoiceId(speaker) ?? existing.voiceId)
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
    [videoOriginalPath]
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
  const generateDubbing = useCallback(() => {
    if (segments.length === 0) return

    // A fresh batch never inherits a previous run's placement progress.
    generationCanceledRef.current = false
    placementCursorRef.current = { nextIndex: 0, runningEndTime: 0 }
    readyForPlacementRef.current.clear()
    failedSegmentIdsRef.current.clear()

    const settings = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey()))

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
    const speakableSegments = segments.filter((seg) => hasSpeakableText(seg.editedText ?? seg.text))
    const silentCount = segments.length - speakableSegments.length
    for (const seg of segments) {
      if (!hasSpeakableText(seg.editedText ?? seg.text)) failedSegmentIdsRef.current.add(seg.id)
    }
    const generationNote = silentCount > 0 ? `${silentCount} line${silentCount === 1 ? ' has' : 's have'} no words to speak (only symbols like ♪ or …, or a [note]) — skipped, no voice made for ${silentCount === 1 ? 'it' : 'them'}.` : undefined
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
      const segState = state.segments[seg.id] ?? defaultDubbingSegmentState(seg.id)
      const speakerId = segState.speakerId ?? seg.speakerId
      const { voiceId } = resolveLineVoice(segState, speakerId ? state.speakers[speakerId] : undefined, settings.engine)
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
        volumeDb: segState.volumeDb
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

    const fallbackControlPrompt = VOICE_MODELS.find((v) => v.id === 'male-adult')?.controlPrompt
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
        volumeDb: unit.volumeDb
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
        groups.push({ voiceId, control: voice?.controlPrompt ?? fallbackControlPrompt, edgeVoice: voice?.edgeVoice, segments: groupSegments })
      }
    }

    const leaderOf = new Map(units.flatMap((unit) => unit.memberIds.map((memberId) => [memberId, unit.leaderId] as const)))
    setState((prev) => {
      const next = { ...prev.segments }
      for (const seg of speakableSegments) {
        next[seg.id] = { ...(next[seg.id] ?? defaultDubbingSegmentState(seg.id)), status: 'generating', joinedInto: leaderOf.get(seg.id) }
      }
      // Progress counts takes -- one result arrives per take, not per line.
      return { ...prev, segments: next, generationProgress: { completed: 0, total: units.length }, generationError: undefined, generationNote }
    })

    void window.api.dubbing.generateBatch({ engine: settings.engine, installDir: settings.installDir, device: settings.device, pitchMatch: settings.pitchMatch, tone: settings.tone, groups })
  }, [segments, state.segments, state.speakers, state.customVoiceReferenceAudioPath, state.customVoiceReferenceText])

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
    setState(withoutTransientDubbingState({ ...saved, speakers: saved.speakers ?? {} }))
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
    const updates = generatedClipPairs()
      .filter(({ segment, clip }) => Math.abs(clip.startTime - segment.startTime) > 0.001)
      .map(({ segment, clip }) => ({ clipId: clip.id, startTime: segment.startTime }))
    if (updates.length > 0) setClipStartTimes(updates)
    return updates.length
  }, [generatedClipPairs, setClipStartTimes])

  const [autoSpeedRunning, setAutoSpeedRunning] = useState(false)

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
        const media = items.find((m) => m.id === clip.mediaId)
        if (!media?.originalPath) continue
        // No 1.28x ceiling here: generation caps speed to protect natural
        // delivery, but Auto-Speed is the user explicitly asking these lines
        // to fit, so fitting wins.
        const speed = clip.duration / availableSeconds
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
  }, [generatedClipPairs, autoSyncDubClips, items, importPaths])

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
    setState({ ...createDefaultDubbingWorkspaceState(), active: true })
    setPendingVideoId(null)
  }, [])

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
      generateDubbing,
      cancelGeneration,
      dismissGenerationMessage,
      restore,
      clearWorkspace,
      autoSyncDubClips,
      autoSpeedDubClips,
      autoSpeedRunning
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
      generateDubbing,
      cancelGeneration,
      dismissGenerationMessage,
      restore,
      clearWorkspace,
      autoSyncDubClips,
      autoSpeedDubClips,
      autoSpeedRunning
    ]
  )

  return <AiDubberContext.Provider value={value}>{children}</AiDubberContext.Provider>
}

export function useAiDubber(): AiDubberContextValue {
  const ctx = useContext(AiDubberContext)
  if (!ctx) throw new Error('useAiDubber must be used within AiDubberProvider')
  return ctx
}
