import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranscriptSegment, Transcript } from '@shared/transcription'
import { parseSrtToSegments, validateSegmentsAgainstDuration } from '@shared/srt'
import {
  createDefaultNarrationWorkspaceState,
  defaultNarrationSegmentState,
  type NarrationWorkspaceState,
  type NarrationSegmentState,
  type NarrationSpeaker,
  type NarrationOptimizationSettings,
  type NarrationTake
} from '@shared/narration'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlaybackTime, usePlaybackControls } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { useUiState, type LeftView, type RightTab } from '../nav/UiStateContext'
import { NARRATION_TRACK_ID } from '../timeline/trackModel'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { useMicrophoneCapture, type MicrophoneCapture } from '../timeline/useMicrophoneCapture'
import { isPastRecordingBound } from '../timeline/recordingBounds'
import { findNextPendingSegment } from './narrationSelection'

type Phase = 'idle' | 'countdown' | 'recording' | 'reviewing'

const COUNTDOWN_SECONDS = 3

export interface PrepareWorkspaceResult {
  segmentCount: number
  warnings: string[]
}

export interface NarrationContextValue {
  state: NarrationWorkspaceState
  active: boolean
  /** The active video's segments (SRT or Whisper-sourced -- see
   * Transcript.source), in file order. Empty until a workspace is prepared. */
  segments: TranscriptSegment[]
  currentSegment: TranscriptSegment | null
  currentSegmentIndex: number
  currentSegmentState: NarrationSegmentState
  /** True while the current segment's pitch-based speaker detection is
   * in flight -- lets the panel show "Detecting..." instead of reading a
   * not-yet-analyzed segment's default speaker:'unknown' as a conclusion. */
  speakerDetecting: boolean

  mic: MicrophoneCapture
  phase: Phase
  countdown: number
  elapsedSeconds: number
  reviewUrl: string | null

  enterStoryNarration: () => void
  exitStoryNarration: () => void
  prepareWorkspace: (params: { videoMediaId: string; srtText: string; srtFileName: string; videoDurationSeconds: number }) => PrepareWorkspaceResult
  /** "Remove SRT" -- clears the loaded video/SRT and returns to the setup
   * screen without leaving Story Narration mode. */
  clearWorkspace: () => void
  selectSegment: (segmentId: string) => void
  goToPreviousSegment: () => void
  goToNextSegment: () => void
  setSpeakerOverride: (segmentId: string, speaker: NarrationSpeaker) => void
  clearSpeakerOverride: (segmentId: string) => void
  setOptimizationSetting: (key: keyof NarrationOptimizationSettings, value: boolean) => void

  startRecording: () => void
  cancelCountdown: () => void
  stopRecording: () => void
  redoTake: () => void
  acceptTake: () => void
  playTake: () => void
  playOriginal: () => void
  reviewAudioRef: React.RefObject<HTMLAudioElement>

  /** Save/Reopen: restores the exact saved workspace state. Does not touch
   * `transcripts`/`sequence` -- those restore independently through their
   * own contexts (the segment text/timing and any accepted VO1 clips are
   * already part of `transcripts`/`sequence`, which restore via the normal
   * project-load path). */
  restore: (saved: NarrationWorkspaceState) => void
}

const NarrationContext = createContext<NarrationContextValue | null>(null)

export function NarrationProvider({ children }: { children: ReactNode }): JSX.Element {
  const { items, importPaths, select: selectMedia } = useMedia()
  const { transcripts, setImportedTranscript } = useTranscript()
  const { currentTime } = usePlaybackTime()
  const { seekTo, setPlaying } = usePlaybackControls()
  const { prepareNarrationTracks, acceptNarrationTake } = useSequence()
  const { beginTransaction, endTransaction } = useHistory()
  const { leftView, setLeftView, rightTab, setRightTab } = useUiState()

  const [state, setState] = useState<NarrationWorkspaceState>(createDefaultNarrationWorkspaceState())
  const [phase, setPhase] = useState<Phase>('idle')
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)

  const mic = useMicrophoneCapture(state.active)

  // Captured once, at the moment Story Narration is entered, so exiting
  // restores exactly what was showing before -- never deleted or reset by
  // simply toggling the mode off and back on.
  const preEntryViewRef = useRef<{ leftView: LeftView; rightTab: RightTab } | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reviewBlobRef = useRef<Blob | null>(null)
  const reviewAudioRef = useRef<HTMLAudioElement>(null)
  const activeBoundRef = useRef<{ start: number; end: number } | null>(null)
  /** Every Accept still waiting on its save/optimize/import round-trip,
   * keyed by the saved file's own path -- NOT a single scalar. `acceptTake`
   * immediately flips back to `phase: 'idle'` and advances to the next
   * segment (so the user can start recording again right away, matching
   * "Accept & Next" -- see acceptTake below), but the actual save+ffmpeg-
   * optimize+import round-trip for the PREVIOUS segment can easily still be
   * in flight at that point. A single ref here used to mean accepting a
   * second segment before the first one's round-trip finished silently
   * overwrote the first entry -- when that first file eventually became
   * `ready`, nothing was watching for it anymore, so its clip never landed
   * on the Timeline and its segment was never marked accepted, with no
   * error surfaced anywhere ("recording doesn't stick"). A Map lets every
   * still-in-flight accept resolve independently, regardless of how many
   * segments the user has since moved on to record. */
  const pendingAcceptsRef = useRef<Map<string, { segmentId: string; startTime: number; clipId: string; previousClipId?: string; durationSeconds: number }>>(new Map())
  /** Segment ids already sent for pitch-based speaker detection this session
   * -- prevents re-firing the effect below on every unrelated
   * `state.segments` change (recording status, take history, etc. for OTHER
   * segments all live in that same object). Swept by clearSpeakerOverride
   * ("Auto") so a segment can be explicitly re-detected on request. */
  const detectedSegmentIdsRef = useRef<Set<string>>(new Set())

  const segments = useMemo(() => (state.videoMediaId ? (transcripts[state.videoMediaId]?.segments ?? []) : []), [state.videoMediaId, transcripts])

  const currentSegmentIndex = useMemo(() => segments.findIndex((s) => s.id === state.currentSegmentId), [segments, state.currentSegmentId])
  const currentSegment = currentSegmentIndex >= 0 ? segments[currentSegmentIndex] : null
  const currentSegmentState = state.currentSegmentId ? (state.segments[state.currentSegmentId] ?? defaultNarrationSegmentState(state.currentSegmentId)) : defaultNarrationSegmentState('')

  const videoOriginalPath = useMemo(() => (state.videoMediaId ? items.find((m) => m.id === state.videoMediaId)?.originalPath : undefined), [state.videoMediaId, items])

  // Segment ids with a detection request currently in flight -- lets the
  // Recording Assistant panel show "Detecting..." instead of prematurely
  // reading a not-yet-analyzed segment's default speaker:'unknown' as if
  // that were the detector's actual (low-confidence) conclusion.
  const [detectingSpeakerIds, setDetectingSpeakerIds] = useState<Set<string>>(new Set())

  // Estimates Male/Female from the ORIGINAL video's own audio over a
  // segment's exact time range (never from the subtitle text) -- see
  // app/main/media/speakerDetect.ts. A manual override always wins and is
  // never touched here; a segment already carrying a (non-manual) confidence
  // is treated as already-detected and skipped.
  const runSpeakerDetection = useCallback(
    (segmentId: string, startTime: number, endTime: number) => {
      if (!videoOriginalPath || detectedSegmentIdsRef.current.has(segmentId)) return
      detectedSegmentIdsRef.current.add(segmentId)
      setDetectingSpeakerIds((prev) => new Set(prev).add(segmentId))
      window.api.narration
        .detectSpeaker(`narration-speaker-${segmentId}`, videoOriginalPath, startTime, endTime)
        .then((result) => {
          setState((prev) => {
            const seg = prev.segments[segmentId] ?? defaultNarrationSegmentState(segmentId)
            if (seg.speakerManualOverride) return prev
            return { ...prev, segments: { ...prev.segments, [segmentId]: { ...seg, speaker: result.speaker, speakerConfidence: result.confidence } } }
          })
        })
        .catch(() => {
          // ffmpeg unavailable or the extraction failed -- leaves the
          // segment at its current speaker/'unknown', same as never having
          // attempted detection at all. Not retried automatically (the user
          // can still set Male/Female manually, or the "Auto" button clears
          // detectedSegmentIdsRef for a fresh attempt).
        })
        .finally(() => {
          setDetectingSpeakerIds((prev) => {
            if (!prev.has(segmentId)) return prev
            const next = new Set(prev)
            next.delete(segmentId)
            return next
          })
        })
    },
    [videoOriginalPath]
  )

  useEffect(() => {
    if (!currentSegment || currentSegmentState.speakerManualOverride) return
    runSpeakerDetection(currentSegment.id, currentSegment.startTime, currentSegment.endTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentSegmentState is read for its manual-override flag only at the moment the segment becomes current, not tracked reactively (that would refire this on every unrelated segment-state change).
  }, [currentSegment, runSpeakerDetection])

  const enterStoryNarration = useCallback(() => {
    preEntryViewRef.current = { leftView, rightTab }
    setState((prev) => ({ ...prev, active: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captured once on entry, deliberately not reactive to further leftView/rightTab changes.
  }, [])

  // Shared by exitStoryNarration and clearWorkspace -- both can fire at ANY
  // phase (the toolbar's "Story Narration ✕" pill, the popover's own toggle,
  // and "Remove SRT" are all reachable mid-recording, not just at 'idle').
  // Leaving `phase` at 'recording'/'countdown' behind would leave App.tsx's
  // focus-mode dimming (which reads `phase` directly) stuck on forever, with
  // no panel left to click Stop from once RecordingAssistantPanel itself has
  // unmounted -- so any in-flight take is torn down first. There's no
  // reviewing UI left to show it in once we've left the workspace (or wiped
  // its segments out from under it), so it's discarded like Redo, not saved.
  const stopAnyInFlightRecording = useCallback(() => {
    if (recorderRef.current && phase === 'recording') {
      recorderRef.current.onstop = null
      recorderRef.current.stop()
      recorderRef.current = null
    }
    chunksRef.current = []
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current)
      elapsedIntervalRef.current = null
    }
    activeBoundRef.current = null
    // A finished-but-not-yet-accepted take (phase 'reviewing') is discarded
    // the same way -- same reasoning as redoTake, just with no segment left
    // to return to.
    setReviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    reviewBlobRef.current = null
    setPlaying(false)
    setPhase('idle')
  }, [phase, setPlaying])

  const exitStoryNarration = useCallback(() => {
    stopAnyInFlightRecording()
    setState((prev) => ({ ...prev, active: false }))
    const restore = preEntryViewRef.current
    if (restore) {
      setLeftView(restore.leftView)
      setRightTab(restore.rightTab)
    }
    preEntryViewRef.current = null
  }, [stopAnyInFlightRecording, setLeftView, setRightTab])

  // "Remove SRT" -- clears the loaded video/SRT/segment bookkeeping and
  // returns to the setup screen (NarrationScriptPanel branches on
  // `state.videoMediaId` being unset), without leaving Story Narration mode
  // entirely. Never touches `transcripts` itself -- the parsed segments
  // simply stop being referenced once `videoMediaId` is cleared. Any
  // already-accepted VO1 clips on the Timeline are untouched too; this only
  // clears the WORKSPACE's own state, not the project's sequence. Mirrors
  // AiDubberContext's own clearWorkspace.
  const clearWorkspace = useCallback(() => {
    stopAnyInFlightRecording()
    detectedSegmentIdsRef.current.clear()
    setState((prev) => ({ ...createDefaultNarrationWorkspaceState(), active: prev.active }))
  }, [stopAnyInFlightRecording])

  const prepareWorkspace = useCallback(
    (params: { videoMediaId: string; srtText: string; srtFileName: string; videoDurationSeconds: number }): PrepareWorkspaceResult => {
      const { segments: parsedSegments, issues } = parseSrtToSegments(params.srtText)
      const { segments: validatedSegments, warnings } = validateSegmentsAgainstDuration(parsedSegments, params.videoDurationSeconds)

      const transcript: Transcript = {
        mediaId: params.videoMediaId,
        segments: validatedSegments,
        requestedLanguage: 'auto',
        generatedAt: new Date().toISOString(),
        audioSourcePath: '',
        source: 'srt'
      }

      // Spans two contexts (transcript + sequence) as one logical step, so
      // it collapses into one Undo entry -- same beginTransaction/
      // endTransaction pattern as TimelineTrackHeaders.handleDeleteTrack.
      beginTransaction()
      setImportedTranscript(params.videoMediaId, transcript)
      selectMedia(params.videoMediaId)
      prepareNarrationTracks()
      endTransaction()

      setState((prev) => ({
        ...prev,
        active: true,
        videoMediaId: params.videoMediaId,
        srtFileName: params.srtFileName,
        currentSegmentId: validatedSegments[0]?.id,
        segments: {}
      }))

      const issueWarnings = issues.map((i) => `Segment ${i.blockIndex + 1}: ${i.reason}`)
      return { segmentCount: validatedSegments.length, warnings: [...issueWarnings, ...warnings] }
    },
    [beginTransaction, endTransaction, setImportedTranscript, selectMedia, prepareNarrationTracks]
  )

  const selectSegment = useCallback(
    (segmentId: string) => {
      const seg = segments.find((s) => s.id === segmentId)
      if (!seg) return
      setState((prev) => ({ ...prev, currentSegmentId: segmentId }))
      // Keeps the auto-stop-at-bound effect in sync with whichever segment
      // is actually selected, so a generic Play (not just "Play Original")
      // right after navigating to a new segment still stops at ITS end,
      // not whatever segment's range happened to be active before.
      activeBoundRef.current = { start: seg.startTime, end: seg.endTime }
      seekTo(seg.startTime)
    },
    [segments, seekTo]
  )

  const goToPreviousSegment = useCallback(() => {
    if (currentSegmentIndex > 0) selectSegment(segments[currentSegmentIndex - 1].id)
  }, [currentSegmentIndex, segments, selectSegment])

  const goToNextSegment = useCallback(() => {
    if (currentSegmentIndex >= 0 && currentSegmentIndex < segments.length - 1) selectSegment(segments[currentSegmentIndex + 1].id)
  }, [currentSegmentIndex, segments, selectSegment])

  const setSpeakerOverride = useCallback((segmentId: string, speaker: NarrationSpeaker) => {
    setState((prev) => ({
      ...prev,
      segments: {
        ...prev.segments,
        [segmentId]: { ...(prev.segments[segmentId] ?? defaultNarrationSegmentState(segmentId)), speaker, speakerManualOverride: true, speakerConfidence: undefined }
      }
    }))
  }, [])

  // "Auto" button: goes back to relying on detection rather than the user's
  // own Male/Female pick. Clearing `speakerConfidence` (not just the override
  // flag) is what makes the pitch-detection effect below re-run for this
  // segment -- `detectedSegmentIdsRef` is also swept so a segment that was
  // already auto-detected once can be re-detected on request.
  const clearSpeakerOverride = useCallback((segmentId: string) => {
    detectedSegmentIdsRef.current.delete(segmentId)
    setState((prev) => ({
      ...prev,
      segments: {
        ...prev.segments,
        [segmentId]: { ...(prev.segments[segmentId] ?? defaultNarrationSegmentState(segmentId)), speakerManualOverride: false, speakerConfidence: undefined }
      }
    }))
  }, [])

  const setOptimizationSetting = useCallback((key: keyof NarrationOptimizationSettings, value: boolean) => {
    setState((prev) => ({ ...prev, optimization: { ...prev.optimization, [key]: value } }))
  }, [])

  const revokeReview = useCallback(() => {
    setReviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    reviewBlobRef.current = null
  }, [])

  const beginRecordingNow = useCallback(() => {
    const stream = mic.streamRef.current
    const segment = currentSegment
    if (!stream || !segment) return
    activeBoundRef.current = { start: segment.startTime, end: segment.endTime }
    chunksRef.current = []
    const recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.start()
    recorderRef.current = recorder
    setPlaying(true)
    setPhase('recording')
    setElapsedSeconds(0)
    if (state.currentSegmentId) {
      const segId = state.currentSegmentId
      setState((prev) => ({ ...prev, segments: { ...prev.segments, [segId]: { ...(prev.segments[segId] ?? defaultNarrationSegmentState(segId)), status: 'recording' } } }))
    }
    elapsedIntervalRef.current = setInterval(() => setElapsedSeconds((e) => e + 1), 1000)
  }, [mic.streamRef, currentSegment, setPlaying, state.currentSegmentId])

  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      beginRecordingNow()
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, beginRecordingNow])

  const startRecording = useCallback(() => {
    if (phase !== 'idle' || !mic.micReady || !currentSegment) return
    seekTo(currentSegment.startTime)
    setCountdown(COUNTDOWN_SECONDS)
    setPhase('countdown')
  }, [phase, mic.micReady, currentSegment, seekTo])

  const cancelCountdown = useCallback(() => setPhase('idle'), [])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || phase !== 'recording') return
    setPlaying(false)
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current)
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      chunksRef.current = []
      reviewBlobRef.current = blob
      setReviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      setPhase('reviewing')
      if (state.currentSegmentId) {
        const segId = state.currentSegmentId
        setState((prev) => ({ ...prev, segments: { ...prev.segments, [segId]: { ...(prev.segments[segId] ?? defaultNarrationSegmentState(segId)), status: 'recorded' } } }))
      }
    }
    recorder.stop()
  }, [phase, setPlaying, state.currentSegmentId])

  // Once playback reaches the CURRENT segment's own end, freeze it there --
  // covers every way playback can be running against a segment's range:
  // recording (never auto-STOPS the recording itself -- see below), review
  // playback, "Play Original", and generic Play while a segment is simply
  // selected. Recording is deliberately excluded from being auto-stopped: a
  // hard cutoff at the exact subtitle boundary silently truncated speech
  // that naturally ran a little longer than the SRT's own timing, which is
  // common (auto-generated/machine-timed subtitles rarely match a real
  // narrator's pacing exactly, and a segment can be as short as 1-2
  // seconds). The user decides when to stop recording (the Stop button);
  // exceeding the target is surfaced as a warning via the timing status
  // (narrationTiming.ts's 'Exceeds range') instead of being silently
  // corrected -- matching "never silently alter" for a take that runs over
  // its target range.
  useEffect(() => {
    const bound = activeBoundRef.current
    if (!bound) return
    if (isPastRecordingBound(currentTime, bound.end)) setPlaying(false)
  }, [currentTime, setPlaying])

  const redoTake = useCallback(() => {
    revokeReview()
    setPhase('idle')
    // Same segment stays active -- the temporary take is simply discarded,
    // never written to disk, so there's nothing to clean up on disk either.
  }, [revokeReview])

  const playTake = useCallback(() => {
    setPlaying(false)
    const audioEl = reviewAudioRef.current
    if (!audioEl) return
    if (phase === 'reviewing' && reviewUrl) {
      // The just-recorded, not-yet-accepted take, still only in memory.
      if (audioEl.src !== reviewUrl) audioEl.src = reviewUrl
      void audioEl.play().catch(() => {})
      return
    }
    // No temp take under review right now (e.g. the user navigated back to
    // a segment that was already Accepted earlier) -- "Play My Take" must
    // still work for it, by playing the ACCEPTED clip's own real, saved
    // media file instead of silently doing nothing.
    const segId = state.currentSegmentId
    const segState = segId ? state.segments[segId] : undefined
    const take = segState?.takes.find((t) => t.id === segState.acceptedTakeId)
    const media = take ? items.find((m) => m.id === take.mediaId) : undefined
    const url = media?.proxyUrl ?? media?.originalUrl
    if (!url) return
    if (audioEl.src !== url) audioEl.src = url
    void audioEl.play().catch(() => {})
  }, [phase, reviewUrl, state.currentSegmentId, state.segments, items, setPlaying])

  const playOriginal = useCallback(() => {
    // Was reading `activeBoundRef`, which is only ever set once a recording
    // has actually started -- clicking "Play Original" on a segment before
    // its first take (the common case) silently did nothing at all, and
    // after navigating to a DIFFERENT segment without recording there yet,
    // it replayed whichever OLD segment's range a past recording had set.
    // Always derives the range from whichever segment is actually selected
    // right now instead.
    const segment = currentSegment
    if (!segment) return
    activeBoundRef.current = { start: segment.startTime, end: segment.endTime }
    reviewAudioRef.current?.pause()
    seekTo(segment.startTime)
    setPlaying(true)
  }, [currentSegment, seekTo, setPlaying])

  const acceptTake = useCallback(() => {
    const blob = reviewBlobRef.current
    const segment = currentSegment
    if (!blob || !segment || !state.currentSegmentId) return
    const segmentId = state.currentSegmentId
    const previousClipId = state.segments[segmentId]?.acceptedClipId
    const clipId = crypto.randomUUID()
    const takeId = crypto.randomUUID()

    revokeReview()
    setPhase('idle')

    void (async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const fileName = `narration-${Date.now()}.webm`
      const savedPath = await window.api.media.saveGeneratedFile(fileName, bytes)
      try {
        // Non-destructive cleanup (trim silence/fade/denoise/normalize/auto-
        // gain per the user's own optimization toggles), applied in place to
        // the SAVED file only -- never to `reviewBlobRef`/`reviewUrl`, so
        // "Play My Take" during review always played exactly what was
        // recorded, unaffected by this. Never alters pitch/speed/words (see
        // app/main/media/narrationAudio.ts).
        await window.api.narration.optimizeTake(takeId, savedPath, state.optimization)
      } catch {
        // Optimization failing (e.g. ffmpeg unavailable) must not block
        // accepting an otherwise-valid, already-saved recording.
      }
      pendingAcceptsRef.current.set(savedPath, { segmentId, startTime: segment.startTime, clipId, previousClipId, durationSeconds: elapsedSeconds })
      await importPaths([savedPath])
    })()

    // Advance to the next not-yet-accepted segment immediately -- the
    // actual clip insertion completes asynchronously (see the `items`
    // effect below) once the save/import pipeline finishes, exactly
    // mirroring VoiceoverRecorder.tsx's own pending-ref-plus-effect timing.
    const nextPending = findNextPendingSegment(segments, currentSegmentIndex, state.segments)
    setState((prev) => ({ ...prev, currentSegmentId: nextPending?.id ?? prev.currentSegmentId }))
    if (nextPending) seekTo(nextPending.startTime)
  }, [currentSegment, state.currentSegmentId, state.segments, state.optimization, revokeReview, elapsedSeconds, importPaths, segments, currentSegmentIndex, seekTo])

  // Once a saved take comes back 'ready' through the normal import
  // pipeline, insert it onto VO1 at its segment's exact start time -- same
  // pending-ref-plus-effect pattern as VoiceoverRecorder.tsx/Freeze Frame,
  // except this drains EVERY still-in-flight accept that's ready this pass
  // (see pendingAcceptsRef's own doc comment), not just one, since the user
  // can easily have accepted several segments in a row before any of their
  // save/optimize/import round-trips finish.
  useEffect(() => {
    if (pendingAcceptsRef.current.size === 0) return
    for (const [path, pending] of pendingAcceptsRef.current) {
      const match = items.find((item) => item.originalPath === path)
      if (!match || (match.stage !== 'ready' && match.stage !== 'error')) continue
      pendingAcceptsRef.current.delete(path)
      if (match.stage === 'error') {
        // The save succeeded but the import pipeline itself failed (corrupt
        // recording, disk issue, ffprobe failure) -- surfaced as "Needs
        // Review" (an existing status the script panel already filters on)
        // instead of silently leaving the segment looking untouched, which
        // otherwise gave no indication this Accept never actually happened.
        setState((prev) => {
          const existing = prev.segments[pending.segmentId] ?? defaultNarrationSegmentState(pending.segmentId)
          return { ...prev, segments: { ...prev.segments, [pending.segmentId]: { ...existing, status: 'needs-review' } } }
        })
        continue
      }

      acceptNarrationTake(NARRATION_TRACK_ID, pending.startTime, assetFromMediaItem(match), pending.clipId, pending.previousClipId)

      const take: NarrationTake = { id: crypto.randomUUID(), mediaId: match.id, createdAt: new Date().toISOString(), durationSeconds: pending.durationSeconds }
      setState((prev) => {
        const existing = prev.segments[pending.segmentId] ?? defaultNarrationSegmentState(pending.segmentId)
        return {
          ...prev,
          segments: {
            ...prev.segments,
            [pending.segmentId]: { ...existing, status: 'accepted', takes: [...existing.takes, take], acceptedTakeId: take.id, acceptedClipId: pending.clipId }
          }
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` should retrigger this; acceptNarrationTake is a stable context callback.
  }, [items])

  useEffect(() => () => revokeReview(), [revokeReview])

  const restore = useCallback((saved: NarrationWorkspaceState) => {
    setState(saved)
  }, [])

  const speakerDetecting = currentSegment !== null && detectingSpeakerIds.has(currentSegment.id)

  const value = useMemo<NarrationContextValue>(
    () => ({
      state,
      active: state.active,
      segments,
      currentSegment,
      currentSegmentIndex,
      currentSegmentState,
      speakerDetecting,
      mic,
      phase,
      countdown,
      elapsedSeconds,
      reviewUrl,
      enterStoryNarration,
      exitStoryNarration,
      prepareWorkspace,
      clearWorkspace,
      selectSegment,
      goToPreviousSegment,
      goToNextSegment,
      setSpeakerOverride,
      clearSpeakerOverride,
      setOptimizationSetting,
      startRecording,
      cancelCountdown,
      stopRecording,
      redoTake,
      acceptTake,
      playTake,
      playOriginal,
      reviewAudioRef,
      restore
    }),
    [
      state,
      segments,
      currentSegment,
      currentSegmentIndex,
      currentSegmentState,
      speakerDetecting,
      mic,
      phase,
      countdown,
      elapsedSeconds,
      reviewUrl,
      enterStoryNarration,
      exitStoryNarration,
      prepareWorkspace,
      clearWorkspace,
      selectSegment,
      goToPreviousSegment,
      goToNextSegment,
      setSpeakerOverride,
      clearSpeakerOverride,
      setOptimizationSetting,
      startRecording,
      cancelCountdown,
      stopRecording,
      redoTake,
      acceptTake,
      playTake,
      playOriginal,
      restore
    ]
  )

  return <NarrationContext.Provider value={value}>{children}</NarrationContext.Provider>
}

export function useNarration(): NarrationContextValue {
  const ctx = useContext(NarrationContext)
  if (!ctx) throw new Error('useNarration must be used within NarrationProvider')
  return ctx
}
