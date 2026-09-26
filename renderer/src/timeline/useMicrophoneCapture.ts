import { useCallback, useEffect, useRef, useState } from 'react'

export interface MicrophoneCapture {
  devices: MediaDeviceInfo[]
  selectedDeviceId: string
  micReady: boolean
  error: string | null
  /** Attach to a plain <div> to drive its width as a live level meter --
   * imperative ref mutation, not React state, matching this codebase's
   * "no per-frame re-render for a drag/audio-frequency visual" convention. */
  levelBarRef: React.RefObject<HTMLDivElement>
  streamRef: React.RefObject<MediaStream | null>
  /** The same live AnalyserNode the level meter reads from -- exposed so a
   * consumer (the Story Narration Workspace's live recording waveform on
   * VO1, see ClipTrack.tsx) can draw its own visualization from the exact
   * same audio tap, without opening a second getUserMedia stream. Null
   * whenever the mic isn't currently open. */
  analyserRef: React.RefObject<AnalyserNode | null>
  openMic: (deviceId?: string) => Promise<void>
  selectDevice: (deviceId: string) => void
  teardown: () => void
}

/** Mic permission, device enumeration, a live RMS level meter, and stream
 * teardown -- extracted from VoiceoverRecorder.tsx's own proven
 * implementation (see app/main/index.ts's setPermissionRequestHandler for
 * the OS-level permission prompt) so the Story Narration Workspace's
 * Recording Assistant panel can reuse the exact same, already-working
 * capture logic without touching VoiceoverRecorder.tsx itself (Quick Record
 * must remain byte-for-byte unchanged). `active` mirrors that component's
 * own `open` popover state: true opens the mic, false tears it down. */
export function useMicrophoneCapture(active: boolean): MicrophoneCapture {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [micReady, setMicReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelBarRef = useRef<HTMLDivElement>(null)
  const levelRafRef = useRef<number | null>(null)

  const stopLevelMeter = useCallback(() => {
    if (levelRafRef.current !== null) cancelAnimationFrame(levelRafRef.current)
    levelRafRef.current = null
  }, [])

  const teardown = useCallback(() => {
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
      teardown()
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
    [teardown, startLevelMeter]
  )

  const selectDevice = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId)
      void openMic(deviceId)
    },
    [openMic]
  )

  useEffect(() => {
    if (active) void openMic(selectedDeviceId || undefined)
    else teardown()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on active toggling; explicit device switches call openMic directly.
  }, [active])

  useEffect(() => teardown, [teardown])

  return { devices, selectedDeviceId, micReady, error, levelBarRef, streamRef, analyserRef, openMic, selectDevice, teardown }
}
