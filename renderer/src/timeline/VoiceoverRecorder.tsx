import { useCallback, useEffect, useRef, useState } from 'react'
import { MicrophoneIcon } from '../nav/icons'
import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { findOrCreateTrack, type OccupiedRange } from './trackModel'
import { formatDuration } from '../media/format'

type Phase = 'idle' | 'countdown' | 'recording'

const COUNTDOWN_SECONDS = 3

/** Record Voiceover (checkpoint 4) -- an entirely new subsystem: mic
 * permission (see app/main/index.ts's setPermissionRequestHandler),
 * device enumeration, a live level meter, a 3-2-1 countdown, then
 * MediaRecorder captures at the playhead while Preview plays back so the
 * user can narrate against picture. The recording is saved via the SAME
 * saveGeneratedFile IPC + import pipeline Freeze Frame uses (no parallel
 * ingest path), then inserted as a real audio clip once the import
 * finishes, auto-routed around whatever's already on the Narration track
 * exactly like every other insertion in this app (findOrCreateTrack). */
export function VoiceoverRecorder(): JSX.Element {
  const { items, importPaths } = useMedia()
  const { currentTime, setPlaying } = usePlayback()
  const { sequence, ensureTrack, insertClip } = useSequence()

  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [micReady, setMicReady] = useState(false)

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

  useEffect(() => {
    if (open) void openMic(selectedDeviceId || undefined)
    else {
      teardownStream()
      setPhase('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on open/close; explicit device switches call openMic directly.
  }, [open])

  useEffect(() => teardownStream, [teardownStream])

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

  const finalizeRecording = useCallback(async (): Promise<void> => {
    const blob = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType || 'audio/webm' })
    chunksRef.current = []
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const fileName = `voiceover-${Date.now()}.webm`
    const savedPath = await window.api.media.saveGeneratedFile(fileName, bytes)
    pendingRef.current = { path: savedPath, atTime: recordStartTimeRef.current }
    await importPaths([savedPath])
  }, [importPaths])

  const handleRecordClick = (): void => {
    if (phase !== 'idle' || !micReady) return
    setCountdown(COUNTDOWN_SECONDS)
    setPhase('countdown')
  }

  const handleCancelCountdown = (): void => {
    setPhase('idle')
  }

  const handleStopClick = (): void => {
    const recorder = recorderRef.current
    if (!recorder || phase !== 'recording') return
    setPlaying(false)
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current)
    recorder.onstop = () => {
      void finalizeRecording()
    }
    recorder.stop()
    setPhase('idle')
  }

  // Once the saved recording comes back 'ready' through the normal import
  // pipeline (MediaContext's onProgress plumbing), insert it as a real
  // audio clip at the time recording actually started -- same
  // pending-ref-plus-effect pattern as TimelineToolbar.tsx's Freeze Frame.
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
        </div>
      )}
    </div>
  )
}
