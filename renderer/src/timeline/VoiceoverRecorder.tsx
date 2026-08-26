import { useCallback, useEffect, useRef, useState } from 'react'
import { MicrophoneIcon } from '../nav/icons'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { useTimelineView } from './TimelineViewContext'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { findOrCreateTrack, type OccupiedRange } from './trackModel'
import { isPastRecordingBound } from './recordingBounds'
import { formatDuration } from '../media/format'

type Mode = 'quick' | 'story'
type Phase = 'idle' | 'countdown' | 'recording' | 'reviewing'

interface RecordingBound {
  start: number
  end: number
  /** The caption segment's text, shown while recording/reviewing a
   * subtitle-driven take -- undefined for a manual custom-range take. */
  label?: string
}

const COUNTDOWN_SECONDS = 3

/** Record Voiceover (checkpoint 4) -- mic permission (see app/main/index.ts's
 * setPermissionRequestHandler), device enumeration, a live level meter, a
 * 3-2-1 countdown, then MediaRecorder captures at the playhead while Preview
 * plays back (with the ORIGINAL audio still audible throughout -- nothing
 * here ever mutes anything) so the user can narrate against picture.
 *
 * Two modes, switchable while idle:
 * - Quick Record: record once at the current playhead, saved via the SAME
 *   saveGeneratedFile IPC + import pipeline Freeze Frame uses, then inserted
 *   as a real audio clip once the import finishes (pendingRef + effect-on-
 *   `items`, below), auto-routed via findOrCreateTrack like every other
 *   insertion in this app. No review step -- same as it's always worked.
 * - Story Narration: steps through each caption/subtitle segment on the
 *   currently-selected media's transcript (or an arbitrary manual range, via
 *   the existing Range tool's `rangeSelection`) one at a time. Recording a
 *   segment does NOT immediately save/import/insert -- the take is held as
 *   an in-memory Blob + object URL for instant review playback ("Play My
 *   Take" / "Play Original", both auto-stopping at the segment's own end via
 *   isPastRecordingBound) until the user clicks Accept (which THEN runs the
 *   exact same save/import/insert path Quick Record always has) or Redo
 *   (discards the blob, tries the same segment again). Accepting advances to
 *   the next not-yet-recorded segment. */
export function VoiceoverRecorder(): JSX.Element {
  const { items, importPaths, selectedId } = useMedia()
  const { transcripts } = useTranscript()
  const { currentTime, setPlaying, seekTo } = usePlayback()
  const { sequence, ensureTrack, insertClip } = useSequence()
  const { rangeSelection } = useTimelineView()

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('quick')
  const [manualRangeMode, setManualRangeMode] = useState(false)
  const [storyIndex, setStoryIndex] = useState(0)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [micReady, setMicReady] = useState(false)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelBarRef = useRef<HTMLDivElement>(null)
  const levelRafRef = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const recordStartTimeRef = useRef(0)
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingRef = useRef<{ path: string; atTime: number } | null>(null)
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = phase
  /** The bound (segment or manual range) a Story Narration take is currently
   * being recorded/reviewed against -- frozen at record-start so it can't
   * shift under the user mid-take even if they change the Range selection
   * or the transcript updates. */
  const activeBoundRef = useRef<RecordingBound | null>(null)
  const reviewBlobRef = useRef<Blob | null>(null)
  const reviewAudioRef = useRef<HTMLAudioElement>(null)

  const media = items.find((m) => m.id === selectedId)
  const segments = media ? (transcripts[media.id]?.segments ?? []) : []

  // A newly-selected media (different transcript) starts the guided workflow
  // over from its first segment.
  useEffect(() => {
    setStoryIndex(0)
  }, [media?.id])

  const currentSegmentBound: RecordingBound | null =
    storyIndex < segments.length
      ? { start: segments[storyIndex].startTime, end: segments[storyIndex].endTime, label: segments[storyIndex].editedText ?? segments[storyIndex].text }
      : null
  const manualBound: RecordingBound | null =
    rangeSelection && rangeSelection.end > rangeSelection.start ? { start: rangeSelection.start, end: rangeSelection.end } : null
  const activeBound = manualRangeMode ? manualBound : currentSegmentBound

  const stopLevelMeter = useCallback(() => {
    if (levelRafRef.current !== null) cancelAnimationFrame(levelRafRef.current)
    levelRafRef.current = null
  }, [])

  const teardownStream = useCallback(() => {
    stopLevelMeter()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current) void audioCtxRef.current.close().catch(() => {})
    audioCtxRef.current = null
    analyserRef.current = null
    setMicReady(false)
  }, [stopLevelMeter])

  const startLevelMeter = useCallback(() => {
    const analyser = analyserRef.current
    const data = new Uint8Array(analyser?.fftSize ?? 0)
    const tick = (): void => {
      const bar = levelBarRef.current
      const a = analyserRef.current
      if (a && bar) {
        a.getByteTimeDomainData(data)
        let sumSquares = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sumSquares += v * v
        }
        const rms = Math.sqrt(sumSquares / data.length)
        bar.style.width = `${Math.min(100, rms * 220)}%`
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  const openMic = useCallback(
    async (deviceId?: string) => {
      setError(null)
      teardownStream()
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true })
        streamRef.current = stream
        const audioCtx = new AudioContext()
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        audioCtxRef.current = audioCtx
        analyserRef.current = analyser
        setMicReady(true)
        startLevelMeter()

        const allDevices = await navigator.mediaDevices.enumerateDevices()
        setDevices(allDevices.filter((d) => d.kind === 'audioinput'))
        const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId
        if (activeDeviceId) setSelectedDeviceId(activeDeviceId)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Microphone access failed')
      }
    },
    [teardownStream, startLevelMeter]
  )

  const revokeReview = useCallback(() => {
    if (reviewUrl) URL.revokeObjectURL(reviewUrl)
    setReviewUrl(null)
    reviewBlobRef.current = null
  }, [reviewUrl])

  useEffect(() => {
    if (open) void openMic(selectedDeviceId || undefined)
    else {
      teardownStream()
      setPhase('idle')
      revokeReview()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on open/close; explicit device switches call openMic directly.
  }, [open])

  useEffect(() => teardownStream, [teardownStream])
  useEffect(() => () => revokeReview(), [revokeReview])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (phaseRef.current !== 'idle') return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const beginRecording = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    chunksRef.current = []
    const recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.start()
    recorderRef.current = recorder
    recordStartTimeRef.current = currentTime
    setPlaying(true)
    setPhase('recording')
    setElapsed(0)
    elapsedIntervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
  }, [currentTime, setPlaying])

  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      beginRecording()
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, beginRecording])

  const finalizeRecording = useCallback(
    async (blob: Blob, atTime: number): Promise<void> => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const fileName = `voiceover-${Date.now()}.webm`
      const savedPath = await window.api.media.saveGeneratedFile(fileName, bytes)
      pendingRef.current = { path: savedPath, atTime }
      await importPaths([savedPath])
    },
    [importPaths]
  )

  const handleRecordClick = (): void => {
    if (phase !== 'idle' || !micReady) return
    setCountdown(COUNTDOWN_SECONDS)
    setPhase('countdown')
  }

  const handleStoryRecordClick = (): void => {
    if (phase !== 'idle' || !micReady || !activeBound) return
    activeBoundRef.current = activeBound
    seekTo(activeBound.start)
    setCountdown(COUNTDOWN_SECONDS)
    setPhase('countdown')
  }

  const handleCancelCountdown = (): void => {
    setPhase('idle')
  }

  // Quick Record's Stop -- unchanged behavior: fire-and-forget straight to
  // save/import/insert, no review step.
  const handleStopClick = (): void => {
    const recorder = recorderRef.current
    if (!recorder || phase !== 'recording') return
    setPlaying(false)
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current)
    const atTime = recordStartTimeRef.current
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      chunksRef.current = []
      void finalizeRecording(blob, atTime)
    }
    recorder.stop()
    setPhase('idle')
  }

  // Story Narration's Stop -- holds the take for review instead of
  // finalizing it immediately. `phase` stays 'recording' for the brief
  // moment until the recorder's `onstop` actually fires (MediaRecorder.stop()
  // is async), then flips to 'reviewing' once the Blob is ready.
  const handleStoryStopClick = useCallback((): void => {
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
    }
    recorder.stop()
  }, [phase, setPlaying])

  // Auto-stop a Story Narration take once playback reaches the active
  // segment/range's own end -- the one genuinely new piece of recording
  // logic this mode needs (Quick Record has no bound to stop at).
  useEffect(() => {
    if (mode !== 'story' || phase !== 'recording') return
    const bound = activeBoundRef.current
    if (!bound) return
    if (isPastRecordingBound(currentTime, bound.end)) handleStoryStopClick()
  }, [currentTime, mode, phase, handleStoryStopClick])

  // While reviewing, "Play Original" auto-pauses at the same bound's end so
  // comparing against the take doesn't run past it into whatever comes next.
  useEffect(() => {
    if (phase !== 'reviewing') return
    const bound = activeBoundRef.current
    if (!bound) return
    if (isPastRecordingBound(currentTime, bound.end)) setPlaying(false)
  }, [currentTime, phase, setPlaying])

  const handlePlayTake = (): void => {
    setPlaying(false)
    reviewAudioRef.current?.play().catch(() => {})
  }

  const handlePlayOriginal = (): void => {
    const bound = activeBoundRef.current
    if (!bound) return
    reviewAudioRef.current?.pause()
    seekTo(bound.start)
    setPlaying(true)
  }

  const handleRedo = (): void => {
    revokeReview()
    setPhase('idle')
    // Same bound (segment/range) stays active -- storyIndex doesn't advance.
  }

  const handleAccept = useCallback((): void => {
    const blob = reviewBlobRef.current
    const bound = activeBoundRef.current
    if (!blob || !bound) return
    setReviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    reviewBlobRef.current = null
    setPhase('idle')
    if (!manualRangeMode) setStoryIndex((i) => i + 1)
    void finalizeRecording(blob, bound.start)
  }, [manualRangeMode, finalizeRecording])

  // Once the saved recording comes back 'ready' through the normal import
  // pipeline (MediaContext's onProgress plumbing), insert it as a real
  // audio clip at the time recording actually started -- same
  // pending-ref-plus-effect pattern as TimelineToolbar.tsx's Freeze Frame.
  // Shared by both modes: Quick Record populates pendingRef right after
  // Stop, Story Narration populates it only once a take is Accepted.
  useEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    const match = items.find((item) => item.originalPath === pending.path)
    if (!match || (match.stage !== 'ready' && match.stage !== 'error')) return
    pendingRef.current = null
    if (match.stage === 'error') return

    const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
    const routing = findOrCreateTrack(sequence.tracks, occupied, pending.atTime, match.metadata?.durationSeconds ?? 0, 'audio')
    if (routing.newTrack) ensureTrack(routing.newTrack)
    insertClip(assetFromMediaItem(match), pending.atTime, routing.trackId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` should retrigger this; the context methods are stable callbacks.
  }, [items])

  const canSwitchMode = phase === 'idle'

  return (
    <div className="track-menu-root" ref={rootRef}>
      <button
        className={open ? 'timeline-tool-button timeline-tool-button-active' : 'timeline-tool-button'}
        title="Record Voiceover"
        aria-label="Record Voiceover"
        onClick={() => setOpen((v) => (v && phase !== 'idle' ? v : !v))}
      >
        <MicrophoneIcon />
      </button>
      {open && (
        <div className="track-menu-popover voiceover-recorder-popover">
          <div className="voiceover-recorder-title">Record Voiceover</div>

          {canSwitchMode && (
            <div className="voiceover-mode-tabs">
              <button className={mode === 'quick' ? 'voiceover-mode-tab voiceover-mode-tab-active' : 'voiceover-mode-tab'} onClick={() => setMode('quick')}>
                Quick Record
              </button>
              <button className={mode === 'story' ? 'voiceover-mode-tab voiceover-mode-tab-active' : 'voiceover-mode-tab'} onClick={() => setMode('story')}>
                Story Narration
              </button>
            </div>
          )}

          {error && <div className="voiceover-recorder-error">{error}</div>}

          {!error && (
            <>
              <select
                className="voiceover-recorder-device-select"
                value={selectedDeviceId}
                disabled={phase !== 'idle'}
                onChange={(e) => {
                  setSelectedDeviceId(e.target.value)
                  void openMic(e.target.value)
                }}
              >
                {devices.length === 0 && <option value="">Default microphone</option>}
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Microphone'}
                  </option>
                ))}
              </select>

              <div className="voiceover-recorder-level-track">
                <div className="voiceover-recorder-level-bar" ref={levelBarRef} />
              </div>

              {mode === 'quick' && (
                <>
                  {phase === 'idle' && (
                    <button className="voiceover-recorder-record-button" disabled={!micReady} onClick={handleRecordClick}>
                      ● Record at Playhead ({formatDuration(currentTime)})
                    </button>
                  )}
                  {phase === 'countdown' && (
                    <div className="voiceover-recorder-countdown">
                      <span>Starting in {countdown}…</span>
                      <button className="voiceover-recorder-cancel-button" onClick={handleCancelCountdown}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {phase === 'recording' && (
                    <div className="voiceover-recorder-recording">
                      <span className="voiceover-recorder-recording-dot" />
                      <span>Recording… {formatDuration(elapsed)}</span>
                      <button className="voiceover-recorder-stop-button" onClick={handleStopClick}>
                        Stop
                      </button>
                    </div>
                  )}
                </>
              )}

              {mode === 'story' && (
                <div className="voiceover-story-panel">
                  {canSwitchMode && (
                    <div className="voiceover-mode-tabs voiceover-story-source-tabs">
                      <button
                        className={!manualRangeMode ? 'voiceover-mode-tab voiceover-mode-tab-active' : 'voiceover-mode-tab'}
                        onClick={() => setManualRangeMode(false)}
                      >
                        By Subtitle
                      </button>
                      <button
                        className={manualRangeMode ? 'voiceover-mode-tab voiceover-mode-tab-active' : 'voiceover-mode-tab'}
                        onClick={() => setManualRangeMode(true)}
                      >
                        Custom Range
                      </button>
                    </div>
                  )}

                  {!manualRangeMode && segments.length === 0 && <p className="voiceover-story-hint">No subtitles yet -- transcribe this media first, or switch to Custom Range.</p>}
                  {!manualRangeMode && segments.length > 0 && !currentSegmentBound && <p className="voiceover-story-hint">All segments recorded.</p>}
                  {manualRangeMode && !manualBound && phase === 'idle' && (
                    <p className="voiceover-story-hint">Drag on the Timeline with the Range tool to pick a custom range to narrate.</p>
                  )}

                  {activeBound && phase === 'idle' && (
                    <div className="voiceover-story-segment">
                      <div className="voiceover-story-segment-time">
                        {formatDuration(activeBound.start)} – {formatDuration(activeBound.end)}
                      </div>
                      {activeBound.label && <div className="voiceover-story-segment-text">{activeBound.label}</div>}
                      <button className="voiceover-recorder-record-button" disabled={!micReady} onClick={handleStoryRecordClick}>
                        ● Record This Segment
                      </button>
                    </div>
                  )}

                  {phase === 'countdown' && (
                    <div className="voiceover-recorder-countdown">
                      <span>Starting in {countdown}…</span>
                      <button className="voiceover-recorder-cancel-button" onClick={handleCancelCountdown}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {phase === 'recording' && (
                    <div className="voiceover-recorder-recording">
                      <span className="voiceover-recorder-recording-dot" />
                      <span>Recording… {formatDuration(elapsed)}</span>
                      <button className="voiceover-recorder-stop-button" onClick={handleStoryStopClick}>
                        Stop
                      </button>
                    </div>
                  )}
                  {phase === 'reviewing' && (
                    <div className="voiceover-story-review">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a just-recorded voice take being reviewed, not user-facing content needing captions. */}
                      <audio ref={reviewAudioRef} src={reviewUrl ?? undefined} />
                      <div className="voiceover-story-review-buttons">
                        <button onClick={handlePlayTake}>▶ Play My Take</button>
                        <button onClick={handlePlayOriginal}>▶ Play Original</button>
                      </div>
                      <div className="voiceover-story-review-buttons">
                        <button className="voiceover-recorder-cancel-button" onClick={handleRedo}>
                          Redo
                        </button>
                        <button className="voiceover-recorder-record-button" onClick={handleAccept}>
                          Accept ✓
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
