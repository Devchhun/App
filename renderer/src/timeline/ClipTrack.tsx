import { memo, useCallback, useEffect, useRef } from 'react'
import type { TimelineClip, Marker } from '@shared/project'
import type { TimelineTrack, TimelineTrackKind } from '@shared/timelineTracks'
import type { MediaItem } from '@shared/media'
import type { KeyframeableProperty } from '@shared/keyframes'
import { useHistory } from '../history/HistoryContext'
import { usePlaybackControls } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { useTimelineView } from './TimelineViewContext'
import { trackDisplayHeight, getMainVideoTrackId, nextTrackId, isNarrationTrackId, DUBBING_TRACK_ID } from './trackModel'
import { buildSnapCandidates, findSnapMatch, type SnapCandidate } from './snapping'
import type { RippleScope } from './timelineViewPrefs'
import { VideoFilmstrip } from './VideoFilmstrip'
import { WaveformTrack } from './WaveformTrack'
import type { ClickModifiers } from '../sequence/sequenceSelection'
import { formatDuration, formatTimecode, stripFileExtension } from '../media/format'
import { clipRate } from '@shared/clipTiming'
import { clampClipSetDelta, resolveMoveSet } from '../sequence/sequenceOps'

interface Props {
  track: TimelineTrack
  clips: TimelineClip[]
  /** Every clip in the whole sequence (all tracks), for snapping candidates
   * -- a clip should be able to snap to edges on OTHER tracks too, not just
   * its own. Only used when Snapping is on. */
  allClips: TimelineClip[]
  tracks: TimelineTrack[]
  /** Sequence-level Timeline markers, for snapping candidates (spec section
   * 4/13) -- only used when Snapping is on. */
  markers: Marker[]
  mediaById: Record<string, MediaItem>
  duration: number
  /** Purely visual floor on this row's own DOM width (background + bottom
   * divider) -- see GraphicsTrack.tsx's identical prop for the full
   * reasoning (the ruler already extends past its own content the same way;
   * this keeps a track row's divider line from stopping short of the
   * header column's own full-width one on a short project). */
  visualMinWidthPx?: number
  pixelsPerSecond: number
  selectedClipIds: string[]
  onSelect: (clipId: string, modifiers?: ClickModifiers) => void
  onDoubleClick: (clip: TimelineClip) => void
  onMove: (clipId: string, newStartTime: number, options?: { magnetic?: boolean; trackId?: string; createTrackKind?: TimelineTrackKind; linked?: boolean }) => void
  onMoveSet: (clipId: string, selectedClipIds: string[], newStartTime: number, linked: boolean) => void
  onTrim: (clipId: string, edge: 'left' | 'right', pointerTime: number, sourceDurationSeconds?: number, options?: { rippleScope?: RippleScope; linked?: boolean }) => void
  /** Blade tool (spec section 4) -- splits `clipId` at `atTime`, independent
   * of the current selection. A no-op for a locked clip or a locked track
   * (checked by the caller, SequenceContext). */
  onBladeSplit: (clipId: string, atTime: number) => void
  /** Roll Edit tool -- drags the shared boundary between two adjacent
   * clips, moving both their trim points together. `sourceDurationSecondsByClip`
   * keyed by clip id, so a right-edge extension doesn't exceed either
   * clip's own real source length. */
  onRollEdit: (leftClipId: string, rightClipId: string, pointerTime: number, sourceDurationSecondsByClip?: Record<string, number | undefined>) => void
  /** Imperatively shows/hides the shared Timeline-wide snap-guide line (owned
   * by Timeline.tsx, matching the skimmer's own ref-mutation pattern rather
   * than React state) -- `null` hides it. Called on every drag/trim
   * pointermove and once more on pointerup to always clear it when the drag
   * ends. */
  onSnapGuide: (time: number | null) => void
  /** Which clip (if any) is currently being moved -- lifted to Timeline.tsx
   * (rather than an imperative classList toggle, this component's usual
   * pattern for drag-frequency visuals) specifically because cross-track
   * dragging unmounts a clip's DOM node from this track and mounts a fresh
   * one on the destination track's own ClipTrack instance mid-gesture; an
   * imperative class on the original element would simply vanish when that
   * happens. Only changes twice per drag (start/end), not per pointermove,
   * so this is nowhere near the per-pixel-state cost the rest of this file
   * deliberately avoids. */
  draggingClipId: string | null
  onDraggingChange: (clipId: string | null) => void
  /** VO1 only: accepted-take numbers keyed by clip id (Story Narration's
   * "Take N" label), and the live in-progress recording region (red) to
   * show while actively recording/reviewing the current segment -- both
   * `undefined`/`null` on every other track. */
  takeLabels?: Record<string, number>
  liveRecordingRegion?: { startTime: number; endTime: number; analyserRef: React.RefObject<AnalyserNode | null>; isRecording: boolean } | null
}

type DragMode = 'move' | 'trim-left' | 'trim-right' | 'roll'

interface DragState {
  clipId: string
  moveIds?: string[]
  moveAsSet?: boolean
  mode: DragMode
  startClientX: number
  originalStartTime: number
  originalDuration: number
  /** Frozen once per pointerdown (not recomputed per move) -- matches
   * snapping.ts's own "build once, match cheaply on every move" contract. */
  snapCandidates: SnapCandidate[]
  /** 'roll' mode only -- the clip on the OTHER side of the boundary. */
  rollPartnerId?: string
  /** Set the first time this drag gesture creates a new track (dropping in
   * the empty area below the last track of the clip's kind) -- every
   * subsequent pointermove that's still in that empty-space zone reuses
   * this SAME track id instead of creating another one. Without this, a
   * single continuous drag through that zone fires many pointermove events
   * (browsers dispatch far more than one per visible frame), and each one
   * independently created a brand-new track and moved the clip onto it --
   * since each new track appends below the last, the "empty space" boundary
   * kept receding out from under an unmoving cursor, so the clip visibly
   * fell through track after track for as long as the drag continued. */
  createdTrackId?: string
  /** Same-track move only: where the clip will land on release. While the
   * pointer is down the clip is only drawn there (a CSS translate on its
   * element -- see performMove), never moved in the sequence, so the
   * neighbours it passes over stay put instead of being ripple-pushed
   * live under the cursor. Cleared whenever a cross-track move takes
   * over (those still apply immediately, the row change IS the feedback). */
  pendingTime?: number
  pendingMagnetic?: boolean
  /** Pointer's y at pointerdown -- the ghost follows the pointer
   * vertically too, so a cross-track move reads as carrying the clip. */
  startClientY: number
  /** Where a move lands on release when the pointer is over another row
   * of the clip's kind (trackId) or the empty area below the last row
   * (createTrackKind) -- applied on pointerup with pendingTime, never live. */
  pendingTrackId?: string
  pendingCreateTrackKind?: 'video' | 'audio'
  /** Continuous pointer-relative vertical ghost offset. The destination
   * row is hit-tested independently, so the clip follows the hand smoothly. */
  ghostY?: number
  /** True when pointerdown deliberately kept an existing multi-selection
   * alive in case this becomes a group drag. If it remains a click, pointerup
   * collapses the selection to this clip. */
  preserveSelectionUntilDrag?: boolean
}

const MIN_CLIP_WIDTH_PX = 6
const SNAP_THRESHOLD_PX = 4
const DRAG_THRESHOLD_PX = 4
/** How close (screen px) a pointerdown must land to a clip's edge, in Roll
 * Edit tool mode, to start a roll drag against whichever clip touches that
 * edge gaplessly -- generous enough to hit reliably without needing pixel
 * precision, matching the spirit of the 10px minimum trim-handle hit area. */
const ROLL_EDGE_HIT_PX = 10

function clipLabel(clip: TimelineClip, media: MediaItem | undefined): string {
  return media ? stripFileExtension(media.fileName) : 'Missing media'
}

/** Sample-and-hold amplitude history, snapshotted at a fixed cadence
 * (independent of React renders) so the bar heights reflect actual recorded
 * loudness over time rather than a single live oscilloscope frame -- this is
 * what a user is asking to SEE when they say recording "doesn't show audio
 * in the Timeline": a real waveform growing as they speak, not just a red
 * placeholder box. Only samples new data while `active` (i.e. actually
 * recording, not merely reviewing a stopped take) -- drawing keeps running
 * regardless so the last-captured shape stays visible afterward. Canvas-based
 * and RAF-driven (no React state per frame), matching this file's own
 * existing "no per-pixel re-render for a drag/audio-frequency visual"
 * convention (see WaveformTrack.tsx / useMicrophoneCapture's level meter). */
function LiveRecordingWaveform({ analyserRef, active }: { analyserRef: React.RefObject<AnalyserNode | null>; active: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const samplesRef = useRef<number[]>([])
  const lastSampleAtRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  // Starting a NEW recording (Redo -> record again, or the next segment)
  // must never show the previous take's leftover waveform shape alongside
  // the new one -- clear the history right as `active` turns true.
  useEffect(() => {
    if (active) samplesRef.current = []
  }, [active])

  useEffect(() => {
    const SAMPLE_INTERVAL_MS = 60
    // Caps history to keep the per-frame draw cost bounded even for a very
    // long segment -- bars simply get thinner (more samples per pixel) once
    // the buffer is full rather than growing without limit.
    const MAX_SAMPLES = 2000

    const draw = (now: number): void => {
      if (activeRef.current) {
        const analyser = analyserRef.current
        if (analyser && now - lastSampleAtRef.current >= SAMPLE_INTERVAL_MS) {
          lastSampleAtRef.current = now
          const data = new Uint8Array(analyser.fftSize)
          analyser.getByteTimeDomainData(data)
          let peak = 0
          for (let i = 0; i < data.length; i++) {
            const v = Math.abs(data[i] - 128) / 128
            if (v > peak) peak = v
          }
          samplesRef.current.push(peak)
          if (samplesRef.current.length > MAX_SAMPLES) samplesRef.current.shift()
        }
      }

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        const w = Math.max(1, Math.round(canvas.clientWidth))
        const h = Math.max(1, Math.round(canvas.clientHeight))
        if (canvas.width !== w) canvas.width = w
        if (canvas.height !== h) canvas.height = h
        ctx.clearRect(0, 0, w, h)
        const samples = samplesRef.current
        if (samples.length > 0) {
          const barWidth = Math.max(1, w / samples.length)
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
          for (let i = 0; i < samples.length; i++) {
            const barH = Math.max(1, samples[i] * h)
            ctx.fillRect(i * barWidth, (h - barH) / 2, Math.max(1, barWidth - 0.5), barH)
          }
        }
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- analyserRef is a stable ref object; `active` is tracked via activeRef so this effect (and its RAF loop) never needs to restart.
  }, [])

  return <canvas ref={canvasRef} className="clip-track-live-recording-canvas" />
}

function clipTypeClass(clip: TimelineClip): string {
  if (clip.type === 'image') return 'clip-track-clip-image'
  if (clip.type === 'audio') return 'clip-track-clip-audio'
  return 'clip-track-clip-video'
}

/** Keyframe Animation's Timeline-side overlay -- diamond markers for
 * `property`'s own keyframes on the SELECTED clip only (never a full
 * multi-lane graph editor, see the feature's own plan), rendered as a child
 * of `.clip-track-clip-body` so `left = keyframe.time * pixelsPerSecond` is
 * already relative to the clip's own box (which is itself positioned at
 * `clip.startTime * pixelsPerSecond`). Dragging a diamond reuses this file's
 * native-pointer-capture drag idiom, but as its own small, self-contained
 * gesture directly on the diamond element rather than through the shared
 * `dragState`/`performMove` machinery above -- that machinery exists to
 * solve cross-track clip movement (magnet/ripple/snap/DOM-remount-mid-drag),
 * none of which applies to repositioning a keyframe in time within its own
 * clip, so folding this into it would only add branches nothing else needs.
 * Deleting a keyframe is a right-click -> "Delete Keyframe" item on the
 * existing clip context menu (Timeline.tsx's handleContextMenu, which
 * hit-tests `data-keyframe-id` before falling back to `data-clip-id`). */
function ClipKeyframeOverlay({
  clip,
  property,
  pixelsPerSecond,
  heightPx,
  onMoveKeyframe
}: {
  clip: TimelineClip
  property: KeyframeableProperty
  pixelsPerSecond: number
  heightPx: number
  onMoveKeyframe: (keyframeId: string, newTime: number) => void
}): JSX.Element | null {
  const { beginTransaction, endTransaction } = useHistory()
  const dragRef = useRef<{ keyframeId: string; startClientX: number; originalTime: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const latestClientXRef = useRef<number | null>(null)

  const keyframes = clip.keyframes?.[property]
  if (!keyframes || keyframes.length === 0) return null
  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  const midY = heightPx / 2

  const commitMove = (clientX: number): void => {
    const drag = dragRef.current
    if (!drag) return
    const deltaSeconds = (clientX - drag.startClientX) / pixelsPerSecond
    onMoveKeyframe(drag.keyframeId, drag.originalTime + deltaSeconds)
  }

  return (
    <div className="clip-keyframe-overlay" style={{ height: heightPx }}>
      {sorted.length > 1 && (
        <div
          className="clip-keyframe-line"
          style={{ left: sorted[0].time * pixelsPerSecond, top: midY, width: (sorted[sorted.length - 1].time - sorted[0].time) * pixelsPerSecond }}
        />
      )}
      {sorted.map((kf) => (
        <div
          key={kf.id}
          className="clip-keyframe-diamond"
          style={{ left: kf.time * pixelsPerSecond, top: midY }}
          data-keyframe-id={kf.id}
          data-keyframe-property={property}
          title={`t=${kf.time.toFixed(2)}s`}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            dragRef.current = { keyframeId: kf.id, startClientX: e.clientX, originalTime: kf.time }
            beginTransaction()
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              // See handlePointerDown's own identical catch above.
            }
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return
            e.stopPropagation()
            latestClientXRef.current = e.clientX
            if (rafRef.current === null) {
              rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null
                if (latestClientXRef.current !== null) commitMove(latestClientXRef.current)
              })
            }
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return
            e.stopPropagation()
            if (rafRef.current !== null) {
              cancelAnimationFrame(rafRef.current)
              rafRef.current = null
              if (latestClientXRef.current !== null) commitMove(latestClientXRef.current)
            }
            dragRef.current = null
            endTransaction()
          }}
        />
      ))}
    </div>
  )
}

/** V1/A1/A2 real Timeline clips -- structurally the same proven drag/trim
 * pattern as GraphicsTrack.tsx (ref-based drag state, no per-pixel
 * re-render, pointer capture, one undo entry per whole drag via
 * beginTransaction/endTransaction), extended with left/right trim that
 * updates sourceIn/sourceOut for video/audio and is source-unbounded for
 * images. Still live-mutates on every pointermove (the ghost-preview-then-
 * commit rework is later work) -- Magnet/Ripple/Snapping route the SAME
 * live onMove/onTrim calls through different math, they don't change this
 * contract. */
function ClipTrackImpl({
  track,
  clips,
  allClips,
  tracks,
  markers,
  mediaById,
  duration,
  visualMinWidthPx,
  pixelsPerSecond,
  selectedClipIds,
  onSelect,
  onDoubleClick,
  onMove,
  onMoveSet,
  onTrim,
  onBladeSplit,
  onRollEdit,
  onSnapGuide,
  draggingClipId,
  onDraggingChange,
  takeLabels,
  liveRecordingRegion
}: Props): JSX.Element {
  const trackLocked = track.locked
  const dragState = useRef<DragState | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  /** Batches the (potentially many) native pointermove events the browser
   * can dispatch per frame down to at most one committed onMove/onTrim per
   * animation frame -- each commit maps over every clip in the sequence and
   * triggers a full re-render, which used to happen on EVERY raw pointermove
   * with no batching at all, and got measurably slower (~2x at 400 clips /
   * 21 tracks vs. a near-empty timeline) as a project grows, feeling
   * increasingly janky to drag. The pointer always visually tracks the
   * cursor immediately either way; this only throttles how often the
   * underlying sequence state actually recomputes. */
  const rafIdRef = useRef<number | null>(null)
  const latestMoveRef = useRef<{ clientX: number; clientY: number; altKey: boolean } | null>(null)
  /** Cross-track drag's currently-highlighted destination row (spec section
   * 9's "target track highlight"), tracked imperatively so switching targets
   * mid-drag doesn't leave a stale highlight on the previous one. */
  const dropTargetElRef = useRef<HTMLElement | null>(null)
  /** Cross-track dragging moves a clip's DOM node from THIS ClipTrack
   * instance's own rendered list to a DIFFERENT track's -- React unmounts it
   * here and mounts a fresh one there, which silently releases native
   * pointer capture (set on that now-detached element in handlePointerDown)
   * partway through a single continuous drag gesture. Once capture is lost,
   * this instance's own onPointerMove/onPointerUp props (bound to the track
   * container div) stop receiving events entirely -- but `dragState.current`
   * never gets cleared, so the NEXT time the pointer happens to pass over
   * this same track for any unrelated reason, it's misread as a
   * continuation of that old, stale drag and silently repositions whatever
   * clip `dragState.current.clipId` used to point at.
   *
   * Fixed by ALSO driving move/up via `window`-level listeners for the
   * duration of a drag (added in handlePointerDown, removed in
   * handlePointerUp) -- `window` never unmounts, so these keep firing
   * regardless of which DOM node currently visually represents the clip.
   * The listener functions themselves must stay REFERENTIALLY STABLE across
   * renders (so add/removeEventListener always target the exact same
   * function), so each is a `useRef`-memoized wrapper created exactly once,
   * delegating to whatever the latest real handler is via a second ref kept
   * up to date on every render (see the assignment right after
   * handlePointerMove/handlePointerUp are defined below). */
  const latestHandlePointerMove = useRef<(e: PointerEvent) => void>(() => {})
  const latestHandlePointerUp = useRef<() => void>(() => {})
  const stableWindowPointerMove = useRef((e: PointerEvent) => latestHandlePointerMove.current(e)).current
  const stableWindowPointerUp = useRef(() => latestHandlePointerUp.current()).current
  const { beginTransaction, endTransaction } = useHistory()
  const { getCurrentTime } = usePlaybackControls()
  const { moveKeyframe } = useSequence()
  const { rippleOn, rippleScope, snappingOn, linkageOn, tool, trackHeightMode, showWaveforms, activeKeyframeProperty } = useTimelineView()

  /** Live timecode/duration tooltip during trim/roll (spec section 5) --
   * updates a DOM node directly via ref rather than React state, matching
   * this file's existing "no per-pixel re-render" drag-visual pattern
   * (ghost/snap-guide equivalents elsewhere use the same trick). */
  const updateTrimTooltip = useCallback((leftPx: number, topPx: number, lines: string[]): void => {
    const el = tooltipRef.current
    if (!el) return
    el.style.display = 'block'
    el.style.left = `${leftPx}px`
    el.style.top = `${topPx}px`
    el.textContent = lines.join(' · ')
  }, [])

  const hideTrimTooltip = useCallback((): void => {
    const el = tooltipRef.current
    if (el) el.style.display = 'none'
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, clip: TimelineClip, mode: DragMode, rollPartnerId?: string) => {
      // Right/middle-click must never select or start a trim/move/roll drag --
      // the trim handles call this directly (bypassing handleToolPointerDown's
      // own button===1/2 bypass above, which only guards the main clip body),
      // so the guard has to live here too. Left unguarded, right-clicking
      // within a selected clip's ~10px trim-handle strip would silently
      // collapse a multi-selection to just that one clip before the context
      // menu opens (see the identical bug this fixes for the clip body).
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      const hasSelectionModifier = e.ctrlKey || e.metaKey || e.shiftKey
      const isExistingMoveSelection =
        mode === 'move' && selectedClipIds.length > 1 && selectedClipIds.includes(clip.id)
      // Dragging any member of an existing multi-selection keeps the set
      // selected, so the normal group-move path below receives every item.
      if (hasSelectionModifier || !isExistingMoveSelection) {
        onSelect(clip.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
      }
      const snapCandidates = buildSnapCandidates({
        clips: allClips,
        markers,
        scenes: [],
        captionSegments: [],
        // Point-in-time read, not a reactive prop -- see
        // PlaybackContext.tsx's own getCurrentTime doc comment. Only ever
        // needed at the exact moment a drag starts, so this no longer
        // forces every clip on this track to re-render 60x/sec during
        // playback for a value never shown in this component's own JSX.
        playheadTime: getCurrentTime(),
        excludeClipIds: new Set([clip.id])
      })
      dragState.current = { clipId: clip.id, mode, moveIds: mode === 'move' ? resolveMoveSet(allClips, clip.id, selectedClipIds, linkageOn) : undefined, moveAsSet: mode === 'move' && resolveMoveSet(allClips, clip.id, selectedClipIds, false).length > 1, startClientX: e.clientX, startClientY: e.clientY, originalStartTime: clip.startTime, originalDuration: clip.duration, snapCandidates, rollPartnerId, preserveSelectionUntilDrag: isExistingMoveSelection && !hasSelectionModifier }
      if (mode === 'move') onDraggingChange(clip.id)
      beginTransaction()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // A synthetic/invalid pointerId (e.g. from automated testing) can't
        // be captured -- move/trim still work via the window-level listeners
        // added just below regardless.
      }
      // See stableWindowPointerMove/Up's own doc comment -- this is what
      // keeps a cross-track drag working correctly instead of leaving a
      // stale dragState behind once native pointer capture is lost.
      window.addEventListener('pointermove', stableWindowPointerMove)
      window.addEventListener('pointerup', stableWindowPointerUp)
    },
    [onSelect, beginTransaction, allClips, markers, getCurrentTime, stableWindowPointerMove, stableWindowPointerUp, onDraggingChange, selectedClipIds, linkageOn]
  )

  /** Blade/Hand/Range tool routing for a clip pointerdown -- Blade splits
   * immediately (no drag state at all, matching "one Undo entry per blade
   * click"); Hand and Range deliberately do nothing here at all (no
   * stopPropagation/preventDefault either) so the event bubbles untouched to
   * Timeline.tsx's own container-level pan/range-select handling. Returns
   * true if the caller should skip its normal Select-tool handling. */
  const handleToolPointerDown = useCallback(
    (e: React.PointerEvent, clip: TimelineClip): boolean => {
      // Middle-mouse-drag pans regardless of the active tool (spec section
      // 14) -- never starts a clip move/trim/split/roll. Right-click must
      // never touch selection either -- a right-click still fires a native
      // pointerdown before its contextmenu event, and letting it fall
      // through to the normal select/move logic below would silently
      // collapse an existing multi-selection to just the right-clicked clip
      // (onSelect() with no ctrl/shift held) before the context menu even
      // opens, disabling every multi-clip menu command. Timeline.tsx's own
      // contextmenu handler is the sole authority on selection for a
      // right-click (it already preserves an existing selection that
      // includes the clicked clip).
      if (e.button === 1 || e.button === 2) return true
      if (tool === 'hand' || tool === 'range') return true
      if (tool === 'blade') {
        e.stopPropagation()
        if (clip.locked || trackLocked) return true
        // Clicked time relative to the clip's own rect (which is already
        // positioned at exactly clip.startTime * pixelsPerSecond).
        const rect = e.currentTarget.getBoundingClientRect()
        const clickedTime = clip.startTime + (e.clientX - rect.left) / pixelsPerSecond
        onBladeSplit(clip.id, clickedTime)
        return true
      }
      if (tool === 'roll') {
        if (clip.locked || trackLocked) return true
        const rect = e.currentTarget.getBoundingClientRect()
        const distFromLeft = e.clientX - rect.left
        const distFromRight = rect.right - e.clientX
        const sameTrack = clips.filter((c) => c.trackId === clip.trackId)
        if (distFromRight <= ROLL_EDGE_HIT_PX) {
          const rightNeighbor = sameTrack.find((c) => Math.abs(c.startTime - (clip.startTime + clip.duration)) < 0.001)
          if (rightNeighbor && !rightNeighbor.locked) {
            handlePointerDown(e, clip, 'roll', rightNeighbor.id)
            return true
          }
        } else if (distFromLeft <= ROLL_EDGE_HIT_PX) {
          const leftNeighbor = sameTrack.find((c) => Math.abs(c.startTime + c.duration - clip.startTime) < 0.001)
          if (leftNeighbor && !leftNeighbor.locked) {
            handlePointerDown(e, leftNeighbor, 'roll', clip.id)
            return true
          }
        }
        // Roll tool over a clip's middle (no adjacent boundary under the
        // pointer) does nothing -- there's no boundary to roll.
        e.stopPropagation()
        return true
      }
      return false
    },
    [tool, trackLocked, pixelsPerSecond, onBladeSplit, clips, handlePointerDown]
  )

  const applySnap = useCallback(
    (rawTime: number, altKey: boolean, candidates: SnapCandidate[]): number => {
      if (!snappingOn || altKey) {
        onSnapGuide(null)
        return rawTime
      }
      const match = findSnapMatch(rawTime, candidates, SNAP_THRESHOLD_PX, pixelsPerSecond)
      onSnapGuide(match.snapped ? match.time : null)
      return match.time
    },
    [snappingOn, pixelsPerSecond, onSnapGuide]
  )

  /** Ghost drawing for a same-track move (see DragState.pendingTime). */
  const setGhostOffset = (clipId: string, offsetPx: number, offsetY = 0): void => {
    const el = document.querySelector<HTMLElement>(`[data-clip-id="${clipId}"]`)
    if (!el) return
    const active = offsetPx !== 0 || offsetY !== 0
    el.style.transform = active ? `translate3d(${offsetPx}px, ${offsetY}px, 0)` : ''
    el.classList.toggle('clip-track-clip-ghosting', active)
    // The row clips its overflow; while it carries a ghost it must not.
    el.closest('.clip-track')?.classList.toggle('clip-track-ghost-host', active)
  }
  /** "New track here" band inside .timeline-tracks-area (one shared
   * element, created on first use). */
  const showNewTrackBand = (clientTop: number, heightPx: number, kind: 'video' | 'audio'): void => {
    const area = document.querySelector<HTMLElement>('.timeline-tracks-area')
    if (!area) return
    let band = area.querySelector<HTMLElement>('.clip-track-new-track-band')
    if (!band) {
      band = document.createElement('div')
      band.className = 'clip-track-new-track-band'
      area.appendChild(band)
    }
    const areaRect = area.getBoundingClientRect()
    const top = Math.max(0, Math.min(areaRect.height - heightPx, clientTop - areaRect.top))
    band.style.top = `${top}px`
    band.style.height = `${heightPx}px`
    band.textContent = kind === 'audio' ? 'New audio track' : 'New video track'
    band.style.display = 'flex'
  }
  const hideNewTrackBand = (): void => {
    const band = document.querySelector<HTMLElement>('.clip-track-new-track-band')
    if (band) band.style.display = 'none'
  }

  const clearGhost = (drag: DragState): void => {
    hideNewTrackBand()
    if (drag.pendingTime === undefined) return
    drag.pendingTime = undefined
    drag.pendingMagnetic = undefined
    drag.ghostY = undefined
    for (const id of drag.moveIds ?? [drag.clipId]) setGhostOffset(id, 0)
  }

  const performMove = useCallback(
    (ev: { clientX: number; clientY: number; altKey: boolean }) => {
      const drag = dragState.current
      if (!drag) return
      // Looked up in `allClips` (the whole sequence), NOT this track's own
      // `clips` prop -- once a cross-track move has already relocated this
      // clip onto a DIFFERENT track earlier in the SAME drag gesture, it no
      // longer appears in THIS ClipTrack instance's own `clips` list at all
      // (that track's clips are grouped by trackId one level up, in
      // Timeline.tsx), which would otherwise silently break further
      // cross-track re-detection (and duration/media lookups) for the rest
      // of that one continuous gesture.
      const clip = allClips.find((c) => c.id === drag.clipId)
      const media = clip ? mediaById[clip.mediaId] : undefined
      const sourceDurationSeconds = media?.metadata?.durationSeconds
      const deltaSeconds = (ev.clientX - drag.startClientX) / pixelsPerSecond

      if (drag.mode === 'move') {
        const raw = drag.originalStartTime + deltaSeconds
        // Never before the Timeline's start: the ghost used to follow the
        // pointer past 00:00 and draw itself over the track header column
        // (the drop was clamped, the picture wasn't).
        const snapped = Math.max(0, applySnap(raw, ev.altKey, drag.snapCandidates))

        // A selection/group moves in time as one unit. Cross-track and
        // magnetic placement remain single-clip operations.
        if (drag.moveAsSet) {
          const offsetSeconds = clampClipSetDelta(allClips, drag.moveIds ?? [], snapped - drag.originalStartTime)
          drag.pendingTime = drag.originalStartTime + offsetSeconds
          drag.pendingMagnetic = false
          const offsetPx = offsetSeconds * pixelsPerSecond
          for (const id of drag.moveIds ?? []) setGhostOffset(id, offsetPx)
          return
        }

        // Cross-track dragging: hit-test the DOM under the pointer for a
        // track row (every ClipTrack/GraphicsTrack carries data-track-id/
        // data-track-kind, CaptionsTrack just data-track-kind). A kind-
        // compatible row that isn't the clip's own track becomes the drop
        // target (highlighted); no row at all (below the last track, inside
        // .timeline-content's own empty area) means a new track of the
        // clip's kind on release, per spec section 9. Nothing moves in the
        // sequence until pointerup -- the clip is only drawn at the pointer
        // (x AND y) meanwhile, see DragState.pendingTime.
        drag.pendingTrackId = undefined
        drag.pendingCreateTrackKind = undefined
        if (clip) {
          const requiredKind = clip.type === 'audio' ? 'audio' : 'video'
          const hit = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null
          const rowEl = hit?.closest('[data-track-kind]') as HTMLElement | null
          // The protected safe zone between the ruler and the first track row
          // (see --timeline-top-safe-zone) must refuse a new-track auto-create
          // exactly like the ruler itself -- otherwise dragging a clip up past
          // the top track would silently spawn a new one in that gap.
          const onRuler = !rowEl && (hit?.closest('.timeline-ruler') || hit?.closest('.timeline-top-safe-zone'))
          let targetRow: HTMLElement | null = null
          let refused = false
          // Keep the picked-up clip directly under the pointer. Destination
          // rows still snap on release, but the in-hand motion must remain
          // continuous instead of jumping by a full track height.
          const ownRowEl = document.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`)?.closest('.clip-track') as HTMLElement | null
          drag.ghostY = ev.clientY - drag.startClientY
          hideNewTrackBand()
          if (rowEl) {
            const hitKind = rowEl.getAttribute('data-track-kind')
            const hitTrackId = rowEl.getAttribute('data-track-id')
            if (hitKind === requiredKind && hitTrackId && hitTrackId !== clip.trackId) {
              drag.pendingTrackId = hitTrackId
              targetRow = rowEl
            } else if (hitTrackId && hitTrackId !== clip.trackId) {
              // Wrong kind of row (audio over video, or the reverse): show
              // it can't take the clip rather than silently doing nothing.
              targetRow = rowEl
              refused = true
            }
          } else if (!onRuler && hit?.closest('.timeline-content')) {
            // Pre-compute the id ONCE per drag gesture (see DragState.createdTrackId's
            // doc comment) so the track created on release has a stable id.
            if (!drag.createdTrackId) drag.createdTrackId = nextTrackId(tracks, requiredKind)
            drag.pendingCreateTrackKind = requiredKind
            drag.pendingTrackId = drag.createdTrackId
            // A band the height of this row, centred on the pointer, shows
            // where the new track will appear while the ghost follows the hand.
            const rowH = ownRowEl?.getBoundingClientRect().height ?? 40
            showNewTrackBand(ev.clientY - rowH / 2, rowH, requiredKind)
          }
          if (dropTargetElRef.current !== targetRow) {
            dropTargetElRef.current?.classList.remove('clip-track-drop-target', 'clip-track-drop-refused')
            dropTargetElRef.current = targetRow
          }
          if (targetRow) {
            targetRow.classList.toggle('clip-track-drop-target', !refused)
            targetRow.classList.toggle('clip-track-drop-refused', refused)
          }
        }

        const isMain = clip ? clip.trackId === getMainVideoTrackId(tracks) : false
        const magnetic = isMain && !drag.pendingTrackId
        // While the pointer is down the picked-up clip floats over every
        // neighbour. Do not move or recolour surrounding items here: the
        // real magnetic/ripple collision resolution runs once on release.
        // Free drag: draw the clip (and its linked partner) at the target,
        // commit on release -- see DragState.pendingTime.
        drag.pendingTime = snapped
        drag.pendingMagnetic = magnetic
        if (clip) {
          const offsetPx = (snapped - clip.startTime) * pixelsPerSecond
          const offsetY = drag.ghostY ?? 0
          setGhostOffset(clip.id, offsetPx, offsetY)
          if (linkageOn && clip.linkedClipId) setGhostOffset(clip.linkedClipId, offsetPx, 0)
        }
      } else if (drag.mode === 'trim-left') {
        const raw = drag.originalStartTime + deltaSeconds
        const snapped = Math.max(0, applySnap(raw, ev.altKey, drag.snapCandidates))
        onTrim(drag.clipId, 'left', snapped, sourceDurationSeconds, { linked: linkageOn })
        const newDuration = drag.originalStartTime + drag.originalDuration - snapped
        const lines = [`${formatDuration(newDuration)}`, `In ${formatDuration(snapped)}`]
        if (clip && clip.type !== 'image') lines.push(`Source in ${formatDuration(Math.max(0, clip.sourceIn + (snapped - drag.originalStartTime) * clipRate(clip)))}`)
        updateTrimTooltip(snapped * pixelsPerSecond, 2, lines)
      } else if (drag.mode === 'trim-right') {
        const raw = drag.originalStartTime + drag.originalDuration + deltaSeconds
        const snapped = applySnap(raw, ev.altKey, drag.snapCandidates)
        onTrim(drag.clipId, 'right', snapped, sourceDurationSeconds, rippleOn ? { rippleScope, linked: linkageOn } : { linked: linkageOn })
        const newDuration = snapped - drag.originalStartTime
        const lines = [`${formatDuration(newDuration)}`, `Out ${formatDuration(snapped)}`]
        if (clip && clip.type !== 'image') lines.push(`Source out ${formatDuration(clip.sourceIn + newDuration)}`)
        updateTrimTooltip(snapped * pixelsPerSecond, 2, lines)
      } else if (drag.mode === 'roll' && drag.rollPartnerId) {
        const raw = drag.originalStartTime + drag.originalDuration + deltaSeconds
        const snapped = applySnap(raw, ev.altKey, drag.snapCandidates)
        const partner = clips.find((c) => c.id === drag.rollPartnerId)
        const partnerMedia = partner ? mediaById[partner.mediaId] : undefined
        onRollEdit(drag.clipId, drag.rollPartnerId, snapped, {
          [drag.clipId]: sourceDurationSeconds,
          [drag.rollPartnerId]: partnerMedia?.metadata?.durationSeconds
        })
        const leftDuration = snapped - drag.originalStartTime
        const rightDuration = partner ? partner.startTime + partner.duration - snapped : 0
        updateTrimTooltip(snapped * pixelsPerSecond, 2, [`${formatDuration(leftDuration)} | ${formatDuration(rightDuration)}`, `Boundary ${formatDuration(snapped)}`])
      }
    },
    [clips, allClips, pixelsPerSecond, mediaById, onMove, onTrim, onRollEdit, applySnap, rippleOn, rippleScope, tracks, linkageOn, updateTrimTooltip]
  )

  // Accepts either a React.PointerEvent (the track div's own onPointerMove/
  // onPointerUp props, for the common same-track case) or a native
  // PointerEvent (from the window listeners handlePointerDown attaches below)
  // -- both shapes carry the three fields this actually reads.
  type PointerLike = { clientX: number; clientY: number; altKey: boolean }

  const handlePointerMove = useCallback(
    (e: PointerLike) => {
      if (!dragState.current) return
      latestMoveRef.current = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey }
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null
          if (latestMoveRef.current) performMove(latestMoveRef.current)
        })
      }
    },
    [performMove]
  )

  const handlePointerUp = useCallback(() => {
    // The stable window listeners added in handlePointerDown -- always
    // remove them here, unconditionally, whether or not a drag was actually
    // still active by this point.
    window.removeEventListener('pointermove', stableWindowPointerMove)
    window.removeEventListener('pointerup', stableWindowPointerUp)
    if (rafIdRef.current !== null) {
      // A commit was still scheduled but hadn't fired yet -- flush it with
      // the latest captured pointer position before canceling, so releasing
      // the mouse never silently drops the final in-flight move (which
      // would otherwise leave the clip a few pixels short of wherever the
      // pointer actually was on pointerup).
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
      if (latestMoveRef.current) performMove(latestMoveRef.current)
    }
    if (dragState.current) {
      const drag = dragState.current
      const draggedClipId = drag.clipId
      // A same-track move was only drawn so far -- this is where it lands.
      const pendingTime = drag.pendingTime
      const pendingMagnetic = drag.pendingMagnetic
      const pendingTrackId = drag.pendingTrackId
      const pendingCreateTrackKind = drag.pendingCreateTrackKind
      const moveIds = drag.moveIds
      const moveAsSet = drag.moveAsSet
      const movedFarEnough = pendingTrackId !== undefined || pendingCreateTrackKind !== undefined || (pendingTime !== undefined && Math.abs(pendingTime - drag.originalStartTime) * pixelsPerSecond >= DRAG_THRESHOLD_PX)
      const collapsePreservedSelection = drag.preserveSelectionUntilDrag && !movedFarEnough
      clearGhost(drag)
      dragState.current = null
      if (collapsePreservedSelection) {
        // Pointerdown kept the group only provisionally. With no real drag,
        // this was a normal click and must leave just this item selected.
        onSelect(draggedClipId)
      } else if (pendingTime !== undefined) {
        if (moveAsSet) onMoveSet(draggedClipId, moveIds ?? [draggedClipId], pendingTime, linkageOn)
        else if (pendingCreateTrackKind && pendingTrackId) onMove(draggedClipId, pendingTime, { createTrackKind: pendingCreateTrackKind, trackId: pendingTrackId, linked: linkageOn })
        else if (pendingTrackId) onMove(draggedClipId, pendingTime, { trackId: pendingTrackId, linked: linkageOn })
        else onMove(draggedClipId, pendingTime, { magnetic: pendingMagnetic, linked: linkageOn })
      }
      endTransaction()
      hideTrimTooltip()
      onSnapGuide(null)
      onDraggingChange(null)
      dropTargetElRef.current?.classList.remove('clip-track-drop-target', 'clip-track-drop-refused')
      dropTargetElRef.current = null
      document.querySelector(`[data-clip-id="${draggedClipId}"]`)?.classList.remove('clip-track-clip-fits-gap', 'clip-track-clip-will-ripple')
    }
  }, [endTransaction, hideTrimTooltip, performMove, onSnapGuide, onDraggingChange, stableWindowPointerMove, stableWindowPointerUp, onMove, onMoveSet, onSelect, linkageOn, pixelsPerSecond])

  // Keep the stable window-listener wrappers pointed at the LATEST
  // handlePointerMove/handlePointerUp closures on every render (see
  // stableWindowPointerMove/Up's own doc comment above) -- a plain ref
  // mutation during render, not an effect, since it must be current by the
  // time any event fires and doesn't itself need to trigger a re-render.
  latestHandlePointerMove.current = handlePointerMove
  latestHandlePointerUp.current = handlePointerUp

  const rowHeight = trackDisplayHeight(track, trackHeightMode)
  // Video/image clips get a real title-bar strip (filename + duration) over
  // a filmstrip body, matching the reference editor's clip design; audio
  // clips skip the opaque strip entirely so the waveform can fill nearly the
  // whole clip height (spec: "waveform fills most of the track height"),
  // with just a subtle overlaid label instead. Clamped so a very short
  // compact-mode row never loses all its body space to the title bar.
  const titleBarHeightPx = Math.min(14, Math.max(0, rowHeight - 10))

  return (
    <div
      className={`timeline-track clip-track clip-track-kind-${track.kind} clip-track-tool-${tool}${track.hidden ? ' timeline-track-hidden' : ''}${track.isMain ? ' timeline-track-sticky-main' : ''}${track.id === DUBBING_TRACK_ID ? ' clip-track-dubbing' : ''}`}
      style={{ width: Math.max(1, duration * pixelsPerSecond, visualMinWidthPx ?? 0), height: rowHeight }}
      data-track-id={track.id}
      data-track-kind={track.kind}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {clips.map((clip) => {
        const media = mediaById[clip.mediaId]
        const locked = clip.locked || trackLocked
        const selected = selectedClipIds.includes(clip.id)
        const dragging = draggingClipId === clip.id
        const widthPx = Math.max(MIN_CLIP_WIDTH_PX, clip.duration * pixelsPerSecond)
        const isAudio = clip.type === 'audio'
        const bodyHeightPx = Math.max(0, rowHeight - (isAudio ? 0 : titleBarHeightPx) - 6)

        return (
          <div
            key={clip.id}
            data-clip-id={clip.id}
            className={`clip-track-clip ${clipTypeClass(clip)}${selected ? ' clip-track-clip-selected' : ''}${locked ? ' clip-track-clip-locked' : ''}${clip.enabled === false ? ' clip-track-clip-disabled' : ''}${dragging ? ' clip-track-clip-dragging' : ''}${isNarrationTrackId(clip.trackId) ? ' clip-track-clip-accepted-take' : ''}`}
            style={{ left: clip.startTime * pixelsPerSecond, width: widthPx }}
            onPointerDown={(e) => {
              if (handleToolPointerDown(e, clip)) return
              if (locked) {
                e.stopPropagation()
                onSelect(clip.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
                return
              }
              handlePointerDown(e, clip, 'move')
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onDoubleClick(clip)
            }}
            title={clipLabel(clip, media)}
          >
            {!isAudio && (
              <div className="clip-track-clip-titlebar" style={{ height: titleBarHeightPx }}>
                <span className="clip-track-clip-title">{clipLabel(clip, media)}</span>
                <span className="clip-track-clip-duration">{formatTimecode(clip.duration, media?.metadata?.frameRate)}</span>
              </div>
            )}

            <div className="clip-track-clip-body" style={{ height: bodyHeightPx }}>
              {clip.type === 'video' && media && (
                <VideoFilmstrip src={media.proxyUrl ?? media.originalUrl} duration={clip.duration * clipRate(clip)} widthPx={widthPx} startOffset={clip.sourceIn} />
              )}
              {clip.type === 'image' && media?.thumbnailUrl && <img className="clip-track-clip-thumb" src={media.thumbnailUrl} alt="" draggable={false} />}
              {isAudio && showWaveforms && (
                <WaveformTrack
                  waveform={media?.waveform}
                  sourceDurationSeconds={media?.metadata?.durationSeconds ?? 0}
                  sourceIn={clip.sourceIn}
                  duration={clip.duration * clipRate(clip)}
                  widthPx={widthPx}
                  heightPx={bodyHeightPx}
                />
              )}
              {selected && activeKeyframeProperty && (
                <ClipKeyframeOverlay
                  clip={clip}
                  property={activeKeyframeProperty}
                  pixelsPerSecond={pixelsPerSecond}
                  heightPx={bodyHeightPx}
                  onMoveKeyframe={(keyframeId, newTime) => moveKeyframe(clip.id, activeKeyframeProperty, keyframeId, newTime)}
                />
              )}
            </div>

            {isAudio && <span className="clip-track-clip-label clip-track-clip-label-audio">{clipLabel(clip, media)}</span>}
            {isNarrationTrackId(clip.trackId) && (
              <span className="clip-track-clip-badge-accepted" title="Accepted narration take">
                Take {takeLabels?.[clip.id] ?? 1} ✓
              </span>
            )}
            {clip.linkedClipId && <span className="clip-track-clip-badge clip-track-clip-badge-linked" title="Linked to its audio/video partner">🔗</span>}
            {clip.locked && <span className="clip-track-clip-badge clip-track-clip-badge-locked" title="Locked">🔒</span>}
            {clip.muted && <span className="clip-track-clip-badge clip-track-clip-badge-muted" title="Muted">🔇</span>}

            {!locked && selected && tool === 'select' && (
              <>
                <div className="clip-track-clip-handle clip-track-clip-handle-left" onPointerDown={(e) => handlePointerDown(e, clip, 'trim-left')}>
                  <span className="clip-track-clip-grip" />
                </div>
                <div className="clip-track-clip-handle clip-track-clip-handle-right" onPointerDown={(e) => handlePointerDown(e, clip, 'trim-right')}>
                  <span className="clip-track-clip-grip" />
                </div>
              </>
            )}
          </div>
        )
      })}
      {liveRecordingRegion && (
        <div
          className="clip-track-live-recording"
          style={{
            left: liveRecordingRegion.startTime * pixelsPerSecond,
            width: Math.max(MIN_CLIP_WIDTH_PX, (liveRecordingRegion.endTime - liveRecordingRegion.startTime) * pixelsPerSecond)
          }}
        >
          <LiveRecordingWaveform analyserRef={liveRecordingRegion.analyserRef} active={liveRecordingRegion.isRecording} />
          <span className="clip-track-live-recording-label">{liveRecordingRegion.isRecording ? 'Recording…' : 'Recorded'}</span>
        </div>
      )}
      <div ref={tooltipRef} className="clip-track-trim-tooltip" style={{ display: 'none' }} />
    </div>
  )
}

// Every prop besides `clips` is already a stable reference from Timeline.tsx
// (see visibleClipsByTrackId's own doc comment there) -- memoized so an
// unrelated Timeline re-render (e.g. another track's drag, an unrelated
// context update) doesn't re-render every OTHER track's full clip list too.
export const ClipTrack = memo(ClipTrackImpl)
