import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/** `live: true` marks a seek as one of many rapid-fire updates during an
 * active scrub drag (Timeline.tsx's ruler/playhead-handle drag) rather than
 * a single deliberate jump -- lets PreviewPlayer.tsx throttle the actual,
 * expensive <video> element seek (a real decoder operation, not free)
 * separately from the cheap playhead-position/timecode UI update, which
 * still happens every frame regardless. Omitted (full precision, no
 * throttling) by every other caller -- keyboard shortcuts, skip buttons,
 * clicking a segment, etc. */
export interface SeekOptions {
  live?: boolean
}

/** Just the fast-changing playhead position -- updated up to 60x/sec during
 * playback via reportTime (PreviewPlayer.tsx's own requestAnimationFrame
 * loop). Split into its own context/hook (usePlaybackTime) so that a
 * component only re-renders on every tick if it actually reads this --
 * everything else lives in PlaybackControlsContext below, which changes only
 * on real user actions (play/pause, seek, mute toggle...). Before this
 * split, both lived in one bundled context value, which forced literally
 * every usePlayback() consumer across the app (~19 files, nearly every
 * panel) to re-render 60x/sec during any playback regardless of whether it
 * used currentTime at all -- confirmed via investigation to be the dominant
 * cause of app-wide UI jank during playback. */
interface PlaybackTimeValue {
  currentTime: number
}

interface PlaybackControlsValue {
  duration: number
  registerSeek: (fn: ((time: number, options?: SeekOptions) => void) | null) => void
  seekTo: (time: number, options?: SeekOptions) => void
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

  /** Non-reactive point-in-time read of the playhead -- for a callback or
   * effect that needs "what's the playhead right now" at the moment of a
   * user action (a keyboard shortcut, an insert-at-playhead click, a
   * drag-snap calculation) WITHOUT subscribing to a re-render on every tick
   * the way usePlaybackTime()'s currentTime would. Backed by a ref that's
   * updated alongside the reactive state in reportTime, so it's always
   * current at call-time despite the function reference itself never
   * changing. */
  getCurrentTime: () => number
}

const PlaybackTimeContext = createContext<PlaybackTimeValue | null>(null)
const PlaybackControlsContext = createContext<PlaybackControlsValue | null>(null)

export function PlaybackProvider({ children }: { children: ReactNode }): JSX.Element {
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [narrationMuted, setNarrationMuted] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const seekFnRef = useRef<((time: number, options?: SeekOptions) => void) | null>(null)
  const playPauseFnRef = useRef<((playing: boolean) => void) | null>(null)
  const frameCaptureFnRef = useRef<(() => string | null) | null>(null)
  const currentTimeRef = useRef(0)

  const registerSeek = useCallback((fn: ((time: number, options?: SeekOptions) => void) | null) => {
    seekFnRef.current = fn
  }, [])

  const seekTo = useCallback((time: number, options?: SeekOptions) => {
    seekFnRef.current?.(time, options)
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
    currentTimeRef.current = time
    setCurrentTime(time)
  }, [])

  const getCurrentTime = useCallback((): number => currentTimeRef.current, [])

  const reportDuration = useCallback((value: number) => {
    setDuration(value)
  }, [])

  const toggleNarrationMuted = useCallback(() => {
    setNarrationMuted((prev) => !prev)
  }, [])

  const timeValue = useMemo<PlaybackTimeValue>(() => ({ currentTime }), [currentTime])

  const controlsValue = useMemo<PlaybackControlsValue>(
    () => ({
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
      captureFrame,
      getCurrentTime
    }),
    [
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
      captureFrame,
      getCurrentTime
    ]
  )

  return (
    <PlaybackControlsContext.Provider value={controlsValue}>
      <PlaybackTimeContext.Provider value={timeValue}>{children}</PlaybackTimeContext.Provider>
    </PlaybackControlsContext.Provider>
  )
}

/** For a component whose own JSX genuinely needs to track the live playhead
 * (a timecode readout, a position-driven highlight) -- re-renders on every
 * tick during playback, same as the old combined usePlayback() did. Only use
 * this when the re-render is actually needed; otherwise see
 * usePlaybackControls()'s getCurrentTime() for a point-in-time read that
 * doesn't subscribe to every tick. */
export function usePlaybackTime(): PlaybackTimeValue {
  const ctx = useContext(PlaybackTimeContext)
  if (!ctx) throw new Error('usePlaybackTime must be used within PlaybackProvider')
  return ctx
}

/** Everything about playback EXCEPT the live time value -- changes only on
 * real user actions (play/pause, seek, mute toggle...), so a component using
 * only this never re-renders during playback itself. */
export function usePlaybackControls(): PlaybackControlsValue {
  const ctx = useContext(PlaybackControlsContext)
  if (!ctx) throw new Error('usePlaybackControls must be used within PlaybackProvider')
  return ctx
}
