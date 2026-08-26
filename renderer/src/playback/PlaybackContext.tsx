import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

interface PlaybackContextValue {
  currentTime: number
  duration: number
  registerSeek: (fn: ((time: number) => void) | null) => void
  seekTo: (time: number) => void
  reportTime: (time: number) => void
  reportDuration: (duration: number) => void
  /** Narration (A1) mute -- shared between the preview player's own volume
   * control and the Timeline's A1 track header, since they mute the same
   * underlying <video> audio. */
  narrationMuted: boolean
  toggleNarrationMuted: () => void

  /** Play/pause, exposed the same registration-indirection way as seek --
   * PreviewPlayer.tsx owns the real play/pause logic (it has to, to touch
   * the <video> element) and registers a handler; keyboard shortcuts
   * (Space/J/K/L, spec section 12) call `setPlaying` without needing to know
   * anything about the player itself, same as they already do for `seekTo`. */
  isPlaying: boolean
  reportPlaying: (playing: boolean) => void
  registerPlayPause: (fn: ((playing: boolean) => void) | null) => void
  setPlaying: (playing: boolean) => void

  /** Freeze Frame (spec section 13/checkpoint 4) -- PreviewPlayer.tsx owns the
   * real <video> element, so it registers a handler that draws the currently
   * displayed frame to an offscreen canvas and returns a PNG data URL; the
   * Timeline toolbar button (which has no reference to the video element)
   * calls `captureFrame` without knowing anything about the player, same
   * registration-indirection pattern as seek/play-pause above. */
  registerFrameCapture: (fn: (() => string | null) | null) => void
  captureFrame: () => string | null
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null)

export function PlaybackProvider({ children }: { children: ReactNode }): JSX.Element {
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [narrationMuted, setNarrationMuted] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const seekFnRef = useRef<((time: number) => void) | null>(null)
  const playPauseFnRef = useRef<((playing: boolean) => void) | null>(null)
  const frameCaptureFnRef = useRef<(() => string | null) | null>(null)

  const registerSeek = useCallback((fn: ((time: number) => void) | null) => {
    seekFnRef.current = fn
  }, [])

  const seekTo = useCallback((time: number) => {
    seekFnRef.current?.(time)
  }, [])

  const reportPlaying = useCallback((playing: boolean) => {
    setIsPlaying(playing)
  }, [])

  const registerPlayPause = useCallback((fn: ((playing: boolean) => void) | null) => {
    playPauseFnRef.current = fn
  }, [])

  const setPlaying = useCallback((playing: boolean) => {
    playPauseFnRef.current?.(playing)
  }, [])

  const registerFrameCapture = useCallback((fn: (() => string | null) | null) => {
    frameCaptureFnRef.current = fn
  }, [])

  const captureFrame = useCallback((): string | null => {
    return frameCaptureFnRef.current?.() ?? null
  }, [])

  const reportTime = useCallback((time: number) => {
    setCurrentTime(time)
  }, [])

  const reportDuration = useCallback((value: number) => {
    setDuration(value)
  }, [])

  const toggleNarrationMuted = useCallback(() => {
    setNarrationMuted((prev) => !prev)
  }, [])

  const value = useMemo<PlaybackContextValue>(
    () => ({
      currentTime,
      duration,
      registerSeek,
      seekTo,
      reportTime,
      reportDuration,
      narrationMuted,
      toggleNarrationMuted,
      isPlaying,
      reportPlaying,
      registerPlayPause,
      setPlaying,
      registerFrameCapture,
      captureFrame
    }),
    [
      currentTime,
      duration,
      registerSeek,
      seekTo,
      reportTime,
      reportDuration,
      narrationMuted,
      toggleNarrationMuted,
      isPlaying,
      reportPlaying,
      registerPlayPause,
      setPlaying,
      registerFrameCapture,
      captureFrame
    ]
  )

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
}

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext)
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider')
  return ctx
}
