import { useCallback, useRef } from 'react'
import type { Scene, TimelineClip, Marker } from '@shared/project'
import type { TimelineTrack } from '@shared/timelineTracks'
import { TEMPLATE_LABELS } from '@shared/templates'
import { useHistory } from '../history/HistoryContext'
import { useTimelineView } from './TimelineViewContext'
import { trackDisplayHeight } from './trackModel'
import { buildSnapCandidates, findSnapMatch, type SnapCandidate } from './snapping'

interface Props {
  track: TimelineTrack
  scenes: Scene[]
  /** For snapping candidates (clip edges on the video/audio tracks) -- see
   * ClipTrack.tsx's identical prop. Only used when Snapping is on. */
  allClips: TimelineClip[]
  allScenes: Scene[]
  markers: Marker[]
  playheadTime: number
  duration: number
  pixelsPerSecond: number
  selectedSceneId: string | null
  onSelect: (sceneId: string) => void
  onRetime: (sceneId: string, startTime: number, endTime: number) => void
}

type DragMode = 'move' | 'resize-left' | 'resize-right'

interface DragState {
  sceneId: string
  mode: DragMode
  startClientX: number
  originalStart: number
  originalEnd: number
  snapCandidates: SnapCandidate[]
}

const MIN_SCENE_DURATION = 0.2
const SNAP_THRESHOLD_PX = 8

export function GraphicsTrack({ track, scenes, allClips, allScenes, markers, playheadTime, duration, pixelsPerSecond, selectedSceneId, onSelect, onRetime }: Props): JSX.Element {
  const trackLocked = track.locked
  const dragState = useRef<DragState | null>(null)
  /** Same rAF-throttled commit pattern as ClipTrack.tsx -- see its comment.
   * Batches native pointermove events to at most one committed onRetime per
   * frame instead of one per raw event. */
  const rafIdRef = useRef<number | null>(null)
  const latestMoveRef = useRef<{ clientX: number; altKey: boolean } | null>(null)
  const { beginTransaction, endTransaction } = useHistory()
  const { snappingOn, tool, trackHeightMode } = useTimelineView()

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, scene: Scene, mode: DragMode) => {
      // Hand/Range/Blade/Roll tools don't operate on graphics clips -- let
      // the event bubble untouched to Timeline.tsx's own container-level
      // pan/range-select/etc. handling (matching ClipTrack.tsx's identical
      // bypass for video/audio clips). Right-click must never start a drag
      // transaction or change selection either -- Timeline.tsx's own
      // contextmenu handler owns selection for a right-click (see
      // ClipTrack.tsx's identical fix for the same root cause).
      if (e.button === 1 || e.button === 2) return
      if (tool !== 'select') return
      e.stopPropagation()
      onSelect(scene.id)
      const snapCandidates = buildSnapCandidates({
        clips: allClips,
        markers,
        scenes: allScenes.filter((s) => s.id !== scene.id),
        captionSegments: [],
        playheadTime,
        excludeClipIds: new Set()
      })
      dragState.current = { sceneId: scene.id, mode, startClientX: e.clientX, originalStart: scene.startTime, originalEnd: scene.endTime, snapCandidates }
      beginTransaction()
      ;(e.target as Element).setPointerCapture(e.pointerId)
    },
    [onSelect, beginTransaction, allClips, allScenes, markers, playheadTime, tool]
  )

  const applySnap = useCallback(
    (rawTime: number, altKey: boolean, candidates: SnapCandidate[]): number => {
      if (!snappingOn || altKey) return rawTime
      return findSnapMatch(rawTime, candidates, SNAP_THRESHOLD_PX, pixelsPerSecond).time
    },
    [snappingOn, pixelsPerSecond]
  )

  const performMove = useCallback(
    (ev: { clientX: number; altKey: boolean }) => {
      const drag = dragState.current
      if (!drag) return
      const deltaSeconds = (ev.clientX - drag.startClientX) / pixelsPerSecond
      let nextStart = drag.originalStart
      let nextEnd = drag.originalEnd

      if (drag.mode === 'move') {
        nextStart = applySnap(drag.originalStart + deltaSeconds, ev.altKey, drag.snapCandidates)
        nextEnd = nextStart + (drag.originalEnd - drag.originalStart)
        if (nextStart < 0) {
          nextEnd -= nextStart
          nextStart = 0
        }
        if (nextEnd > duration) {
          nextStart -= nextEnd - duration
          nextEnd = duration
        }
      } else if (drag.mode === 'resize-left') {
        const raw = applySnap(drag.originalStart + deltaSeconds, ev.altKey, drag.snapCandidates)
        nextStart = Math.min(drag.originalEnd - MIN_SCENE_DURATION, Math.max(0, raw))
      } else {
        const raw = applySnap(drag.originalEnd + deltaSeconds, ev.altKey, drag.snapCandidates)
        nextEnd = Math.max(drag.originalStart + MIN_SCENE_DURATION, Math.min(duration, raw))
      }

      onRetime(drag.sceneId, nextStart, nextEnd)
    },
    [pixelsPerSecond, duration, onRetime, applySnap]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState.current) return
      latestMoveRef.current = { clientX: e.clientX, altKey: e.altKey }
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
      // Flush any still-pending commit with the latest position first -- see
      // ClipTrack.tsx's identical fix for why (otherwise pointerup can
      // silently drop the final in-flight move).
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
      if (latestMoveRef.current) performMove(latestMoveRef.current)
    }
    if (dragState.current) {
      dragState.current = null
      endTransaction()
    }
  }, [endTransaction, performMove])

  return (
    <div
      className={`timeline-track timeline-track-graphics${track.hidden ? ' timeline-track-hidden' : ''}`}
      style={{ width: Math.max(1, duration * pixelsPerSecond), height: trackDisplayHeight(track, trackHeightMode) }}
      data-track-id={track.id}
      data-track-kind={track.kind}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {scenes.map((scene) => {
        const locked = scene.locked || trackLocked
        return (
          <div
            key={scene.id}
            className={`graphics-clip graphics-clip-${scene.templateId}${scene.id === selectedSceneId ? ' graphics-clip-selected' : ''}${
              locked ? ' graphics-clip-locked' : ''
            }`}
            style={{ left: scene.startTime * pixelsPerSecond, width: Math.max(4, (scene.endTime - scene.startTime) * pixelsPerSecond) }}
            onPointerDown={(e) => {
              if (e.button === 1 || tool !== 'select') return
              if (locked) {
                e.stopPropagation()
                onSelect(scene.id)
                return
              }
              handlePointerDown(e, scene, 'move')
            }}
            title={`${TEMPLATE_LABELS[scene.templateId]}: ${scene.visualText}`}
          >
            {!locked && (
              <div className="graphics-clip-handle graphics-clip-handle-left" onPointerDown={(e) => handlePointerDown(e, scene, 'resize-left')} />
            )}
            <span className="graphics-clip-fx">fx</span>
            <span className="graphics-clip-text">{scene.visualText}</span>
            {!locked && (
              <div className="graphics-clip-handle graphics-clip-handle-right" onPointerDown={(e) => handlePointerDown(e, scene, 'resize-right')} />
            )}
          </div>
        )
      })}
    </div>
  )
}
