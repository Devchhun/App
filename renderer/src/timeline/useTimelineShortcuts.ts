import { useCallback, useEffect, useRef } from 'react'
import { useSequence } from '../sequence/SequenceContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useTimelineView, MIN_PPS, MAX_PPS } from './TimelineViewContext'
import { frameDuration } from './frameMath'

function isEditingText(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const tag = el?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el?.isContentEditable)
}

const MAX_SHUTTLE_SPEED = 8
const FRAME_STEP_FPS = 30

/** Global Timeline keyboard shortcuts for the real clip system (V1/A1/A2) --
 * separate from HistoryContext's own Ctrl+Z/Shift+Z/Y handler (undo/redo
 * stays generic there). Every handler bails out while the user is typing in
 * an input/textarea, matching that same existing guard.
 *
 * Deliberately does NOT call beginTransaction/endTransaction around these --
 * each action here is a single, already-atomic state update (unlike a
 * pointer drag's many intermediate updates), so HistoryContext's own
 * automatic recordChange (fired by its snapshot-watching effect on every
 * render where nothing is mid-transaction) already captures it as exactly
 * one undo step. Wrapping a single synchronous action in
 * begin+mutate+end back-to-back is actually a bug: React batches the state
 * update, so `endTransaction` would still see the PRE-mutation snapshot and
 * record a no-op. */
export function useTimelineShortcuts(sequenceDuration: number): void {
  const {
    sequence,
    selectedTimelineClipIds,
    selectClips,
    deleteSelected,
    duplicateSelected,
    splitSelected,
    clearClipSelection,
    copySelected,
    cutSelected,
    pasteAtTime,
    pasteAttributesToSelected,
    deleteRange,
    addMarkerAtTime
  } = useSequence()
  const { currentTime, seekTo, isPlaying, setPlaying } = usePlayback()
  const { linkageOn, tool, setTool, rangeSelection, setRangeSelection, rippleScope, pixelsPerSecond, setPixelsPerSecond, timelineViewportWidth } = useTimelineView()

  // J/K/L shuttle -- forward playback uses the real <video> element (smooth,
  // native decode) at 1x; a REPEATED L (already forward-shuttling) and every
  // J (reverse isn't natively supported by the <video> element at all)
  // switch to a manual requestAnimationFrame scrub loop that drives the
  // playhead directly via `seekTo` -- genuinely moves through the footage in
  // real time, just not through native decode, so faster multiples look
  // stepped rather than perfectly smooth. Speed doubles (up to 8x) on each
  // repeated same-direction press, matching "repeated J/L increase speed."
  const shuttleRef = useRef<{ direction: 1 | -1; speed: number; rafId: number } | null>(null)
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime

  const stopShuttle = useCallback(() => {
    if (shuttleRef.current) cancelAnimationFrame(shuttleRef.current.rafId)
    shuttleRef.current = null
  }, [])

  const startShuttle = useCallback(
    (direction: 1 | -1, speed: number) => {
      setPlaying(false)
      let last = performance.now()
      const tick = (now: number): void => {
        const dt = (now - last) / 1000
        last = now
        const next = Math.max(0, Math.min(sequenceDuration, currentTimeRef.current + direction * speed * dt))
        seekTo(next)
        currentTimeRef.current = next
        const rafId = requestAnimationFrame(tick)
        shuttleRef.current = { direction, speed, rafId }
      }
      const rafId = requestAnimationFrame(tick)
      shuttleRef.current = { direction, speed, rafId }
    },
    [seekTo, setPlaying, sequenceDuration]
  )

  useEffect(() => stopShuttle, [stopShuttle])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isEditingText(e.target)) return

      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'd' && selectedTimelineClipIds.length > 0) {
          e.preventDefault()
          duplicateSelected({ linked: linkageOn })
        } else if (e.key.toLowerCase() === 'c' && selectedTimelineClipIds.length > 0) {
          e.preventDefault()
          copySelected()
        } else if (e.key.toLowerCase() === 'x' && selectedTimelineClipIds.length > 0) {
          e.preventDefault()
          cutSelected({ linked: linkageOn })
        } else if (e.key.toLowerCase() === 'v' && e.shiftKey) {
          e.preventDefault()
          pasteAttributesToSelected()
        } else if (e.key.toLowerCase() === 'v') {
          e.preventDefault()
          pasteAtTime(currentTime)
        } else if (e.key.toLowerCase() === 'a') {
          e.preventDefault()
          selectClips(sequence.clips.map((c) => c.id))
        }
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && rangeSelection) {
        e.preventDefault()
        // Shift+Delete = Ripple Delete Range (spec section 9), matching the
        // same Shift-forces-ripple convention as the clip-selection case below.
        deleteRange(rangeSelection, e.shiftKey)
        setRangeSelection(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTimelineClipIds.length > 0) {
        e.preventDefault()
        // Shift+Delete = Ripple Delete (spec section 9) using the current
        // Ripple-scope setting regardless of whether the Ripple toggle itself
        // is on -- an explicit command, not gated by the ambient toggle.
        deleteSelected(e.shiftKey ? { rippleScope } : { linked: linkageOn })
      } else if (e.key.toLowerCase() === 's' && selectedTimelineClipIds.length > 0) {
        e.preventDefault()
        // Alt is a per-action override that forces an UNlinked split
        // regardless of the Linkage toggle; otherwise the toggle decides.
        splitSelected(currentTime, { linked: e.altKey ? false : linkageOn })
      } else if (e.key.toLowerCase() === 'a' && tool !== 'select') {
        e.preventDefault()
        setTool('select')
      } else if (e.key.toLowerCase() === 'b' && tool !== 'blade') {
        e.preventDefault()
        setTool('blade')
      } else if (e.key.toLowerCase() === 'h' && tool !== 'hand') {
        e.preventDefault()
        setTool('hand')
      } else if (e.key.toLowerCase() === 'r' && tool !== 'range') {
        e.preventDefault()
        setTool('range')
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        setPixelsPerSecond(Math.min(MAX_PPS, pixelsPerSecond * 1.25))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setPixelsPerSecond(Math.max(MIN_PPS, pixelsPerSecond / 1.25))
      } else if (e.key === '\\') {
        e.preventDefault()
        if (sequenceDuration > 0) setPixelsPerSecond(Math.max(MIN_PPS, Math.min(MAX_PPS, timelineViewportWidth / sequenceDuration)))
      } else if (e.key === ' ') {
        e.preventDefault()
        stopShuttle()
        setPlaying(!isPlaying)
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        stopShuttle()
        setPlaying(false)
      } else if (e.key.toLowerCase() === 'l') {
        e.preventDefault()
        const s = shuttleRef.current
        if (s && s.direction === 1) {
          startShuttle(1, Math.min(MAX_SHUTTLE_SPEED, s.speed * 2))
        } else if (isPlaying) {
          startShuttle(1, 2)
        } else {
          stopShuttle()
          setPlaying(true)
        }
      } else if (e.key.toLowerCase() === 'j') {
        e.preventDefault()
        const s = shuttleRef.current
        startShuttle(-1, s && s.direction === -1 ? Math.min(MAX_SHUTTLE_SPEED, s.speed * 2) : 1)
      } else if (e.key === 'ArrowLeft' && e.altKey) {
        // Jump to previous marker -- distinct from ArrowUp/Down's "any clip
        // boundary" edit-point jump above.
        e.preventDefault()
        stopShuttle()
        const before = sequence.markers.map((m) => m.time).filter((t) => t < currentTime - 1e-6)
        if (before.length > 0) seekTo(Math.max(...before))
      } else if (e.key === 'ArrowRight' && e.altKey) {
        e.preventDefault()
        stopShuttle()
        const after = sequence.markers.map((m) => m.time).filter((t) => t > currentTime + 1e-6)
        if (after.length > 0) seekTo(Math.min(...after))
      } else if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault()
        stopShuttle()
        seekTo(Math.max(0, currentTime - 1))
      } else if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault()
        stopShuttle()
        seekTo(Math.min(sequenceDuration, currentTime + 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        stopShuttle()
        seekTo(Math.max(0, currentTime - frameDuration(FRAME_STEP_FPS)))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        stopShuttle()
        seekTo(Math.min(sequenceDuration, currentTime + frameDuration(FRAME_STEP_FPS)))
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Previous/next edit point -- the nearest clip boundary (any clip's
        // start or end) strictly before/after the playhead, across every track.
        e.preventDefault()
        stopShuttle()
        const boundaries = sequence.clips.flatMap((c) => [c.startTime, c.startTime + c.duration])
        const candidates = e.key === 'ArrowUp' ? boundaries.filter((t) => t < currentTime - 1e-6) : boundaries.filter((t) => t > currentTime + 1e-6)
        if (candidates.length > 0) {
          seekTo(e.key === 'ArrowUp' ? Math.max(...candidates) : Math.min(...candidates))
        }
      } else if (e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setRangeSelection({ start: currentTime, end: Math.max(currentTime, rangeSelection?.end ?? currentTime) })
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setRangeSelection({ start: Math.min(currentTime, rangeSelection?.start ?? currentTime), end: currentTime })
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault()
        addMarkerAtTime(currentTime)
      } else if (e.key === 'Escape') {
        stopShuttle()
        clearClipSelection()
        setRangeSelection(null)
      } else if (e.key === 'Home') {
        e.preventDefault()
        stopShuttle()
        seekTo(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        stopShuttle()
        seekTo(sequenceDuration)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    sequence,
    selectedTimelineClipIds,
    selectClips,
    deleteSelected,
    duplicateSelected,
    splitSelected,
    clearClipSelection,
    copySelected,
    cutSelected,
    pasteAtTime,
    pasteAttributesToSelected,
    currentTime,
    seekTo,
    isPlaying,
    setPlaying,
    startShuttle,
    stopShuttle,
    sequenceDuration,
    linkageOn,
    tool,
    setTool,
    rangeSelection,
    setRangeSelection,
    rippleScope,
    deleteRange,
    addMarkerAtTime,
    pixelsPerSecond,
    setPixelsPerSecond,
    timelineViewportWidth
  ])
}
