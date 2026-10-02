import { useCallback, useEffect, useRef } from 'react'
import type { TranscriptSegment } from '@shared/transcription'
import type { ClickModifiers } from '../sequence/sequenceSelection'

interface Props {
  segments: TranscriptSegment[]
  /** Only these are drawn (the ones in view); `segments` still drives drag
   * logic. A whole series is thousands of subtitles -- drawing all of them
   * on every frame of playback was most of what made it slow. */
  visibleSegments?: TranscriptSegment[]
  duration: number
  /** Purely visual floor on this row's own DOM width -- see GraphicsTrack.tsx's
   * identical prop for the full reasoning. */
  visualMinWidthPx?: number
  pixelsPerSecond: number
  activeSegmentId: string | null
  selectedSegmentIds?: string[]
  onSelect?: (segmentId: string, modifiers: ClickModifiers) => void
  onSeek: (time: number) => void
  /** Slides a subtitle to a new start time (its length is kept). Omit to
   * make the row read-only, as it was before dragging existed. */
  onMove?: (segmentId: string, newStartTime: number) => void
  /** Moves an existing multi-selection as one group. */
  onMoveSet?: (segmentIds: string[], draggedSegmentId: string, newStartTime: number) => void
  height: number
  hidden?: boolean
}

/** A press that travels less than this is a click (seek), not a drag --
 * same threshold idea as Timeline.tsx's BOX_SELECT_THRESHOLD_PX, so a slightly
 * shaky click never nudges a subtitle by a few pixels by accident. */
const DRAG_THRESHOLD_PX = 4

interface DragState {
  segmentId: string
  startClientX: number
  originalStartTime: number
  moveIds: string[]
  moveEls: HTMLElement[]
  moved: boolean
  /** Where the block is right now, so pointerup can commit it. */
  latestStartTime: number
}

export function CaptionsTrack({ segments, visibleSegments, duration, visualMinWidthPx, pixelsPerSecond, activeSegmentId, selectedSegmentIds = [], onSelect, onSeek, onMove, onMoveSet, height, hidden }: Props): JSX.Element {
  const widthPx = Math.max(1, Math.round(duration * pixelsPerSecond), visualMinWidthPx ?? 0)

  const dragRef = useRef<DragState | null>(null)
  const rafRef = useRef<number | null>(null)
  const latestClientXRef = useRef(0)

  // Per-frame preview by mutating the selected blocks' transforms -- no
  // React state, so a drag never re-renders the whole Timeline per pixel
  // (the same convention ClipTrack.tsx's own drags follow). The real
  // transcript update happens once, on release.
  const applyFrame = useCallback(() => {
    rafRef.current = null
    const drag = dragRef.current
    if (!drag) return
    const deltaPx = latestClientXRef.current - drag.startClientX
    if (!drag.moved && Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    const selected = segments.filter((segment) => drag.moveIds.includes(segment.id))
    const minimumStart = Math.min(...selected.map((segment) => segment.startTime))
    const deltaSeconds = Math.max(-minimumStart, deltaPx / pixelsPerSecond)
    drag.latestStartTime = drag.originalStartTime + deltaSeconds
    for (const el of drag.moveEls) {
      el.style.transform = `translate3d(${deltaSeconds * pixelsPerSecond}px, 0, 0)`
      el.classList.add('timeline-caption-dragging')
      el.closest('.timeline-track')?.classList.add('timeline-track-drag-host')
    }
  }, [pixelsPerSecond, segments])

  const handleWindowPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragRef.current) return
      latestClientXRef.current = e.clientX
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(applyFrame)
    },
    [applyFrame]
  )

  const handleWindowPointerUp = useCallback(() => {
    window.removeEventListener('pointermove', handleWindowPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      applyFrame()
    }
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    for (const el of drag.moveEls) {
      el.style.transform = ''
      el.classList.remove('timeline-caption-dragging')
      el.closest('.timeline-track')?.classList.remove('timeline-track-drag-host')
    }
    if (drag.moved) {
      if (drag.moveIds.length > 1) onMoveSet?.(drag.moveIds, drag.segmentId, drag.latestStartTime)
      else onMove?.(drag.segmentId, drag.latestStartTime)
    } else {
      // Pointerdown may have provisionally preserved a group so it could be
      // dragged together. Since no drag happened, this is a normal click:
      // collapse the selection to only the clicked caption.
      onSelect?.(drag.segmentId, {})
      onSeek(drag.originalStartTime)
    }
  }, [applyFrame, handleWindowPointerMove, onMove, onMoveSet, onSelect, onSeek])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, seg: TranscriptSegment) => {
      if (e.button !== 0) return
      e.stopPropagation()
      // The Timeline's own box-select listens to the compatibility
      // MOUSE event, which stopPropagation on this POINTER event does not
      // touch -- preventDefault here is what cancels it (same as
      // ClipTrack.tsx). Without it, grabbing a caption drew a marquee.
      e.preventDefault()
      const hasModifier = e.ctrlKey || e.metaKey || e.shiftKey
      const isExistingMultiSelection = selectedSegmentIds.length > 1 && selectedSegmentIds.includes(seg.id)
      // Grabbing one member of an existing selection must not collapse it
      // before the drag starts. A modified click still updates selection.
      if (hasModifier || !isExistingMultiSelection) {
        onSelect?.(seg.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
      }
      if (!onMove && !onMoveSet) {
        onSeek(seg.startTime)
        return
      }
      const moveIds = isExistingMultiSelection ? [...selectedSegmentIds] : [seg.id]
      const row = e.currentTarget.parentElement
      const moveEls = moveIds
        .map((id) => row?.querySelector<HTMLElement>(`[data-caption-id="${CSS.escape(id)}"]`) ?? null)
        .filter((el): el is HTMLElement => el !== null)
      dragRef.current = {
        segmentId: seg.id,
        startClientX: e.clientX,
        originalStartTime: seg.startTime,
        moveIds,
        moveEls,
        moved: false,
        latestStartTime: seg.startTime
      }
      latestClientXRef.current = e.clientX
      // Window listeners, not the element's own: the pointer leaves a
      // 2px-wide block long before the drag is over.
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp)
    },
    [onMove, onMoveSet, onSelect, onSeek, selectedSegmentIds, handleWindowPointerMove, handleWindowPointerUp]
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      const drag = dragRef.current
      if (drag) {
        for (const el of drag.moveEls) {
          el.style.transform = ''
          el.classList.remove('timeline-caption-dragging')
          el.closest('.timeline-track')?.classList.remove('timeline-track-drag-host')
        }
      }
    }
  }, [handleWindowPointerMove, handleWindowPointerUp])

  return (
    <div
      className={`timeline-track timeline-track-captions${hidden ? ' timeline-track-hidden' : ''}`}
      style={{ width: widthPx, height }}
      data-track-kind="caption"
    >
      {(visibleSegments ?? segments).map((seg) => {
        const left = seg.startTime * pixelsPerSecond
        const width = Math.max(2, (seg.endTime - seg.startTime) * pixelsPerSecond)
        const text = seg.editedText ?? seg.text
        const classes = [
          'timeline-caption-block',
          onMove ? 'timeline-caption-movable' : '',
          seg.needsReview ? 'timeline-caption-review' : '',
          selectedSegmentIds.includes(seg.id) ? 'timeline-caption-selected' : '',
          seg.id === activeSegmentId ? 'timeline-caption-active' : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={seg.id}
            data-caption-id={seg.id}
            className={classes}
            style={{ left, width }}
            title={onMove ? `${text}\nDrag to move` : text}
            onPointerDown={(e) => handlePointerDown(e, seg)}
            // Click is handled on pointerup above (threshold decides seek vs
            // move); this only stops the Timeline's own background handler.
            onClick={(e) => e.stopPropagation()}
          >
            <span className="timeline-caption-text" lang="km">
              {text}
            </span>
          </button>
        )
      })}
    </div>
  )
}
