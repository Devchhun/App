import { useRef, useState } from 'react'
import type { Marker } from '@shared/project'
import { formatDuration } from '../media/format'
import { useSequence } from '../sequence/SequenceContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useHistory } from '../history/HistoryContext'
import { computeRulerTicks } from './rulerTicks'

interface Props {
  duration: number
  pixelsPerSecond: number
  markers: Marker[]
  /** Visible horizontal time window (project-absolute seconds, already
   * including Timeline.tsx's own margin) -- ticks (major and minor) outside
   * it are skipped entirely. `undefined` renders every tick across the
   * whole `duration` (the old, uncapped behavior), which is fine for a
   * short project but becomes thousands of DOM nodes for a long one (a
   * 2-hour timeline at a typical zoom level generated over 7,000 minor-tick
   * elements alone) -- Timeline.tsx always passes the real window. */
  viewStart?: number
  viewEnd?: number
}

/** Movement past this (px) while a marker flag is held down counts as a drag
 * rather than a click-to-seek -- matches the same click-vs-drag threshold
 * convention used for box-select elsewhere in the Timeline. */
const MARKER_DRAG_THRESHOLD_PX = 4

export function TimeRuler({ duration, pixelsPerSecond, markers, viewStart, viewEnd }: Props): JSX.Element {
  const { moveMarkerTo, updateMarkerFields, removeMarkerById } = useSequence()
  const { seekTo } = usePlayback()
  const { beginTransaction, endTransaction } = useHistory()
  const rulerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ markerId: string; moved: boolean; pointerId: number } | null>(null)
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  const rangeStart = Math.max(0, viewStart ?? 0)
  const rangeEnd = Math.min(duration, viewEnd ?? duration)

  // Only the ticks whose time actually falls within the visible range --
  // indices computed directly from rangeStart/rangeEnd rather than
  // generating the full 0..duration series and filtering it, so the array
  // size only ever depends on how much TIME is on screen, never on the
  // project's total duration. See rulerTicks.ts for why ticks never exceed
  // `duration` itself.
  const { majorTicks: ticks, minorTicks } = computeRulerTicks(duration, pixelsPerSecond, rangeStart, rangeEnd)

  const timeFromClientX = (clientX: number): number => {
    const rect = rulerRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, (clientX - rect.left) / pixelsPerSecond)
  }

  const handleMarkerPointerDown = (e: React.PointerEvent, marker: Marker): void => {
    e.preventDefault()
    e.stopPropagation()
    if (marker.id === editingMarkerId) return
    dragRef.current = { markerId: marker.id, moved: false, pointerId: e.pointerId }
    beginTransaction()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handleMarkerPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.stopPropagation()
    drag.moved = true
    moveMarkerTo(drag.markerId, timeFromClientX(e.clientX))
  }

  const handleMarkerPointerUp = (e: React.PointerEvent, marker: Marker): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.stopPropagation()
    dragRef.current = null
    endTransaction()
    if (!drag.moved) seekTo(marker.time)
  }

  const openEditor = (marker: Marker): void => {
    setEditingMarkerId(marker.id)
    setNameDraft(marker.name)
  }

  const commitEdit = (): void => {
    if (editingMarkerId) {
      const trimmed = nameDraft.trim()
      if (trimmed) updateMarkerFields(editingMarkerId, { name: trimmed })
    }
    setEditingMarkerId(null)
  }

  return (
    <div className="timeline-ruler" style={{ width: duration * pixelsPerSecond }} ref={rulerRef}>
      {minorTicks.map((t) => (
        <div key={t} className="timeline-tick-minor" style={{ left: t * pixelsPerSecond }} />
      ))}
      {ticks.map((t) => (
        <div key={t} className="timeline-tick" style={{ left: t * pixelsPerSecond }}>
          <span className="timeline-tick-label">{formatDuration(t)}</span>
        </div>
      ))}

      {markers.map((marker) => (
        <div
          key={marker.id}
          className="timeline-marker-flag"
          style={{ left: marker.time * pixelsPerSecond, background: marker.color }}
          title={marker.name}
          onPointerDown={(e) => handleMarkerPointerDown(e, marker)}
          onPointerMove={handleMarkerPointerMove}
          onPointerUp={(e) => handleMarkerPointerUp(e, marker)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            openEditor(marker)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            openEditor(marker)
          }}
        />
      ))}

      {editingMarkerId &&
        (() => {
          const marker = markers.find((m) => m.id === editingMarkerId)
          if (!marker) return null
          return (
            <div className="timeline-marker-editor" style={{ left: marker.time * pixelsPerSecond }} onPointerDown={(e) => e.stopPropagation()}>
              <input
                className="timeline-marker-editor-input"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingMarkerId(null)
                }}
              />
              <button
                className="timeline-marker-editor-delete"
                title="Delete Marker"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  removeMarkerById(marker.id)
                  setEditingMarkerId(null)
                }}
              >
                ×
              </button>
            </div>
          )
        })()}
    </div>
  )
}
