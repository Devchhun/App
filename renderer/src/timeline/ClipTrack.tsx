import { useCallback, useRef } from 'react'
import type { TimelineClip, Marker } from '@shared/project'
import type { TimelineTrack, TimelineTrackKind } from '@shared/timelineTracks'
import type { MediaItem } from '@shared/media'
import { useHistory } from '../history/HistoryContext'
import { useTimelineView } from './TimelineViewContext'
import { trackDisplayHeight, getMainVideoTrackId } from './trackModel'
import { buildSnapCandidates, findSnapMatch, type SnapCandidate } from './snapping'
import type { RippleScope } from './timelineViewPrefs'
import { VideoFilmstrip } from './VideoFilmstrip'
import type { ClickModifiers } from '../sequence/sequenceSelection'
import { formatDuration } from '../media/format'

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
  playheadTime: number
  mediaById: Record<string, MediaItem>
  duration: number
  pixelsPerSecond: number
  selectedClipIds: string[]
  onSelect: (clipId: string, modifiers?: ClickModifiers) => void
  onDoubleClick: (clip: TimelineClip) => void
  onMove: (clipId: string, newStartTime: number, options?: { magnetic?: boolean; trackId?: string; createTrackKind?: TimelineTrackKind; linked?: boolean }) => void
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
}

type DragMode = 'move' | 'trim-left' | 'trim-right' | 'roll'

interface DragState {
  clipId: string
  mode: DragMode
  startClientX: number
  originalStartTime: number
  originalDuration: number
  /** Frozen once per pointerdown (not recomputed per move) -- matches
   * snapping.ts's own "build once, match cheaply on every move" contract. */
  snapCandidates: SnapCandidate[]
  /** 'roll' mode only -- the clip on the OTHER side of the boundary. */
  rollPartnerId?: string
}

const MIN_CLIP_WIDTH_PX = 6
const SNAP_THRESHOLD_PX = 8
/** How close (screen px) a pointerdown must land to a clip's edge, in Roll
 * Edit tool mode, to start a roll drag against whichever clip touches that
 * edge gaplessly -- generous enough to hit reliably without needing pixel
 * precision, matching the spirit of the 10px minimum trim-handle hit area. */
const ROLL_EDGE_HIT_PX = 10

function clipLabel(clip: TimelineClip, media: MediaItem | undefined): string {
  return media?.fileName ?? 'Missing media'
}

function clipTypeClass(clip: TimelineClip): string {
  if (clip.type === 'image') return 'clip-track-clip-image'
  if (clip.type === 'audio') return 'clip-track-clip-audio'
  return 'clip-track-clip-video'
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
export function ClipTrack({
  track,
  clips,
  allClips,
  tracks,
  markers,
  playheadTime,
  mediaById,
  duration,
  pixelsPerSecond,
  selectedClipIds,
  onSelect,
  onDoubleClick,
  onMove,
  onTrim,
  onBladeSplit,
  onRollEdit
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
  const { beginTransaction, endTransaction } = useHistory()
  const { magnetOn, rippleOn, rippleScope, snappingOn, linkageOn, tool, trackHeightMode } = useTimelineView()

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
      onSelect(clip.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
      const snapCandidates = buildSnapCandidates({
        clips: allClips,
        markers,
        scenes: [],
        captionSegments: [],
        playheadTime,
        excludeClipIds: new Set([clip.id])
      })
      dragState.current = { clipId: clip.id, mode, startClientX: e.clientX, originalStartTime: clip.startTime, originalDuration: clip.duration, snapCandidates, rollPartnerId }
      beginTransaction()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // A synthetic/invalid pointerId (e.g. from automated testing) can't
        // be captured -- move/trim still work via the track's own
        // pointermove/pointerup listeners, just without capture-outside-bounds.
      }
    },
    [onSelect, beginTransaction, allClips, markers, playheadTime]
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
      if (!snappingOn || altKey) return rawTime
      return findSnapMatch(rawTime, candidates, SNAP_THRESHOLD_PX, pixelsPerSecond).time
    },
    [snappingOn, pixelsPerSecond]
  )

  const performMove = useCallback(
    (ev: { clientX: number; clientY: number; altKey: boolean }) => {
      const drag = dragState.current
      if (!drag) return
      const clip = clips.find((c) => c.id === drag.clipId)
      const media = clip ? mediaById[clip.mediaId] : undefined
      const sourceDurationSeconds = media?.metadata?.durationSeconds
      const deltaSeconds = (ev.clientX - drag.startClientX) / pixelsPerSecond

      if (drag.mode === 'move') {
        const raw = drag.originalStartTime + deltaSeconds
        const snapped = applySnap(raw, ev.altKey, drag.snapCandidates)

        // Cross-track dragging: hit-test the DOM under the pointer for a
        // track row (every ClipTrack/GraphicsTrack carries data-track-id/
        // data-track-kind, CaptionsTrack just data-track-kind) rather than
        // tracking scroll-relative geometry ourselves. A kind-compatible row
        // that isn't the clip's own track moves it there; no row at all
        // (below the last track, inside .timeline-content's own empty area)
        // auto-creates a new track of the clip's kind, per spec section 9.
        if (clip) {
          const requiredKind = clip.type === 'audio' ? 'audio' : 'video'
          const hit = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null
          const rowEl = hit?.closest('[data-track-kind]') as HTMLElement | null
          const onRuler = !rowEl && hit?.closest('.timeline-ruler')
          if (rowEl) {
            const hitKind = rowEl.getAttribute('data-track-kind')
            const hitTrackId = rowEl.getAttribute('data-track-id')
            if (hitKind === requiredKind && hitTrackId && hitTrackId !== clip.trackId) {
              if (dropTargetElRef.current !== rowEl) {
                dropTargetElRef.current?.classList.remove('clip-track-drop-target')
                rowEl.classList.add('clip-track-drop-target')
                dropTargetElRef.current = rowEl
              }
              onMove(drag.clipId, snapped, { trackId: hitTrackId, linked: linkageOn })
              return
            }
          } else if (!onRuler) {
            dropTargetElRef.current?.classList.remove('clip-track-drop-target')
            dropTargetElRef.current = null
            onMove(drag.clipId, snapped, { createTrackKind: requiredKind, linked: linkageOn })
            return
          }
        }
        if (dropTargetElRef.current) {
          dropTargetElRef.current.classList.remove('clip-track-drop-target')
          dropTargetElRef.current = null
        }

        const isMain = clip ? clip.trackId === getMainVideoTrackId(tracks) : false
        onMove(drag.clipId, snapped, { magnetic: magnetOn && isMain, linked: linkageOn })
      } else if (drag.mode === 'trim-left') {
        const raw = drag.originalStartTime + deltaSeconds
        const snapped = applySnap(raw, ev.altKey, drag.snapCandidates)
        onTrim(drag.clipId, 'left', snapped, sourceDurationSeconds, { linked: linkageOn })
        const newDuration = drag.originalStartTime + drag.originalDuration - snapped
        const lines = [`${formatDuration(newDuration)}`, `In ${formatDuration(snapped)}`]
        if (clip && clip.type !== 'image') lines.push(`Source in ${formatDuration(Math.max(0, clip.sourceIn + (snapped - drag.originalStartTime)))}`)
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
    [clips, pixelsPerSecond, mediaById, onMove, onTrim, onRollEdit, applySnap, magnetOn, rippleOn, rippleScope, tracks, linkageOn, updateTrimTooltip]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
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
      dragState.current = null
      endTransaction()
      hideTrimTooltip()
      dropTargetElRef.current?.classList.remove('clip-track-drop-target')
      dropTargetElRef.current = null
    }
  }, [endTransaction, hideTrimTooltip, performMove])

  return (
    <div
      className={`timeline-track clip-track clip-track-kind-${track.kind} clip-track-tool-${tool}${track.hidden ? ' timeline-track-hidden' : ''}`}
      style={{ width: Math.max(1, duration * pixelsPerSecond), height: trackDisplayHeight(track, trackHeightMode) }}
      data-track-id={track.id}
      data-track-kind={track.kind}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {clips.map((clip) => {
        const media = mediaById[clip.mediaId]
        const locked = clip.locked || trackLocked
        const selected = selectedClipIds.includes(clip.id)
        const widthPx = Math.max(MIN_CLIP_WIDTH_PX, clip.duration * pixelsPerSecond)

        return (
          <div
            key={clip.id}
            data-clip-id={clip.id}
            className={`clip-track-clip ${clipTypeClass(clip)}${selected ? ' clip-track-clip-selected' : ''}${locked ? ' clip-track-clip-locked' : ''}${clip.enabled === false ? ' clip-track-clip-disabled' : ''}`}
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
            {clip.type === 'video' && media && (
              <VideoFilmstrip src={media.proxyUrl ?? media.originalUrl} duration={clip.duration} widthPx={widthPx} startOffset={clip.sourceIn} />
            )}
            {clip.type === 'image' && media?.thumbnailUrl && <img className="clip-track-clip-thumb" src={media.thumbnailUrl} alt="" draggable={false} />}

            <span className="clip-track-clip-type-icon">{clip.type === 'video' ? '▶' : clip.type === 'image' ? '🖼' : '♪'}</span>
            <span className="clip-track-clip-label">{clipLabel(clip, media)}</span>
            {clip.linkedClipId && <span className="clip-track-clip-badge clip-track-clip-badge-linked" title="Linked to its audio/video partner">🔗</span>}
            {clip.locked && <span className="clip-track-clip-badge clip-track-clip-badge-locked" title="Locked">🔒</span>}
            {clip.muted && <span className="clip-track-clip-badge clip-track-clip-badge-muted" title="Muted">🔇</span>}

            {!locked && selected && tool === 'select' && (
              <>
                <div className="clip-track-clip-handle clip-track-clip-handle-left" onPointerDown={(e) => handlePointerDown(e, clip, 'trim-left')} />
                <div className="clip-track-clip-handle clip-track-clip-handle-right" onPointerDown={(e) => handlePointerDown(e, clip, 'trim-right')} />
              </>
            )}
          </div>
        )
      })}
      <div ref={tooltipRef} className="clip-track-trim-tooltip" style={{ display: 'none' }} />
    </div>
  )
}
