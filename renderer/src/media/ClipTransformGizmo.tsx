import { useRef, useState } from 'react'
import type { TimelineClip, ClipTransform } from '@shared/project'
import { interpolateKeyframes, isAnimated, type KeyframeableProperty } from '@shared/keyframes'
import { positionScale } from '@shared/clipPosition'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'

const IDENTITY: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }
/** Within this many stage pixels of the centre, the picture snaps to it. */
const SNAP_PX = 6
/** Within this many degrees of a right angle, the turn snaps to it. */
const SNAP_DEG = 3
const MIN_SCALE = 0.05

type Corner = 'nw' | 'ne' | 'se' | 'sw'
type Drag =
  | { kind: 'move'; startX: number; startY: number; x0: number; y0: number }
  | { kind: 'scale'; d0: number; sx0: number; sy0: number }
  | { kind: 'rotate'; a0: number; r0: number }

interface Props {
  clip: TimelineClip
  /** The Player's picture area, in pixels. */
  stageSize: { width: number; height: number }
  /** The clip's media size, to fit it into the stage as the Player does. */
  mediaSize: { width?: number; height?: number } | undefined
  fit: 'contain' | 'cover'
  currentTime: number
}

/** CapCut's frame around the selected picture in the Player: drag inside
 * to move it (it snaps to the centre, cyan guides showing), a corner to
 * size it, the round handle under it to turn it (snapping at right
 * angles). One drag is one Undo step; a property that has keyframes gets
 * its keyframe at the playhead set instead of its plain value (which the
 * keyframes would override). */
export function ClipTransformGizmo({ clip, stageSize, mediaSize, fit, currentTime }: Props): JSX.Element | null {
  const { updateClipProperties, addOrUpdateKeyframe } = useSequence()
  const { beginTransaction, endTransaction } = useHistory()
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const frameRef = useRef(0)
  const pendingRef = useRef<Partial<ClipTransform> | null>(null)
  const [snap, setSnap] = useState<{ x: boolean; y: boolean }>({ x: false, y: false })

  const mw = mediaSize?.width
  const mh = mediaSize?.height
  if (!mw || !mh || clip.locked) return null

  const t = clip.transform ?? IDENTITY
  const kf = clip.keyframes
  const timeInClip = currentTime - clip.startTime
  const value = (prop: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'): number => interpolateKeyframes(kf?.[prop], timeInClip, t[prop])
  const x = value('x')
  const y = value('y')
  const scaleX = value('scaleX')
  const scaleY = value('scaleY')
  const rotation = value('rotation')
  const unit = positionScale(stageSize)
  const fitScale = fit === 'cover' ? Math.max(stageSize.width / mw, stageSize.height / mh) : Math.min(stageSize.width / mw, stageSize.height / mh)
  const cx = stageSize.width / 2 + x * unit
  const cy = stageSize.height / 2 + y * unit
  const w = Math.abs(mw * fitScale * scaleX)
  const h = Math.abs(mh * fitScale * scaleY)

  /** Writes the change: keyframed properties get a keyframe at the playhead,
   * the rest go into the plain transform. Batched to one write a frame. */
  const apply = (patch: Partial<ClipTransform>): void => {
    pendingRef.current = { ...pendingRef.current, ...patch }
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      const next = pendingRef.current
      pendingRef.current = null
      if (!next) return
      const plain: Partial<ClipTransform> = {}
      for (const [prop, v] of Object.entries(next) as [keyof ClipTransform, number][]) {
        if (isAnimated(kf?.[prop as KeyframeableProperty])) addOrUpdateKeyframe(clip.id, prop as KeyframeableProperty, timeInClip, v)
        else plain[prop] = v
      }
      if (Object.keys(plain).length > 0) updateClipProperties(clip.id, { transform: { ...t, ...plain } })
    })
  }

  /** Pointer position in stage pixels. */
  const stagePoint = (e: React.PointerEvent): { px: number; py: number } => {
    const stage = boxRef.current?.parentElement?.getBoundingClientRect()
    return { px: e.clientX - (stage?.left ?? 0), py: e.clientY - (stage?.top ?? 0) }
  }

  const start = (e: React.PointerEvent, drag: Drag): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // A pointer the browser no longer tracks: the drag still follows it.
    }
    dragRef.current = drag
    beginTransaction()
  }

  const onMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    const { px, py } = stagePoint(e)
    if (drag.kind === 'move') {
      let nx = drag.x0 + (px - drag.startX) / unit
      let ny = drag.y0 + (py - drag.startY) / unit
      const snapX = Math.abs(nx * unit) < SNAP_PX
      const snapY = Math.abs(ny * unit) < SNAP_PX
      if (snapX) nx = 0
      if (snapY) ny = 0
      setSnap((s) => (s.x === snapX && s.y === snapY ? s : { x: snapX, y: snapY }))
      apply({ x: nx, y: ny })
    } else if (drag.kind === 'scale') {
      const d = Math.hypot(px - cx, py - cy)
      const ratio = drag.d0 > 0 ? d / drag.d0 : 1
      apply({ scaleX: Math.max(MIN_SCALE, drag.sx0 * ratio), scaleY: Math.max(MIN_SCALE, drag.sy0 * ratio) })
    } else {
      const a = (Math.atan2(py - cy, px - cx) * 180) / Math.PI
      let r = drag.r0 + (a - drag.a0)
      r = ((((r + 180) % 360) + 360) % 360) - 180
      const nearest = Math.round(r / 90) * 90
      if (Math.abs(r - nearest) < SNAP_DEG) r = nearest
      apply({ rotation: Math.round(r * 10) / 10 })
    }
  }

  const onUp = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // already released
    }
    setSnap({ x: false, y: false })
    // The last batched write lands before the Undo step closes.
    requestAnimationFrame(() => requestAnimationFrame(() => endTransaction()))
  }

  // On the frame only: a handle's pointer events bubble up to it.
  const handlers = { onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp }

  const startMove = (e: React.PointerEvent): void => {
    const { px, py } = stagePoint(e)
    start(e, { kind: 'move', startX: px, startY: py, x0: x, y0: y })
  }
  const startScale = (e: React.PointerEvent): void => {
    const { px, py } = stagePoint(e)
    start(e, { kind: 'scale', d0: Math.hypot(px - cx, py - cy), sx0: scaleX, sy0: scaleY })
  }
  const startRotate = (e: React.PointerEvent): void => {
    const { px, py } = stagePoint(e)
    start(e, { kind: 'rotate', a0: (Math.atan2(py - cy, px - cx) * 180) / Math.PI, r0: rotation })
  }

  const corners: Corner[] = ['nw', 'ne', 'se', 'sw']
  return (
    <>
      {snap.x && <div className="clip-gizmo-guide clip-gizmo-guide-v" />}
      {snap.y && <div className="clip-gizmo-guide clip-gizmo-guide-h" />}
      <div
        ref={boxRef}
        className="clip-gizmo"
        style={{ left: cx, top: cy, width: w, height: h, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
        title="Drag to move · corners to resize · the round handle to rotate"
        onPointerDown={startMove}
        {...handlers}
      >
        <span className="clip-gizmo-cross clip-gizmo-cross-v" />
        <span className="clip-gizmo-cross clip-gizmo-cross-h" />
        {corners.map((corner) => (
          <span key={corner} className={`clip-gizmo-handle clip-gizmo-${corner}`} onPointerDown={startScale} />
        ))}
        <span className="clip-gizmo-rotate" title="Rotate (snaps at 0°, 90°, 180°)" onPointerDown={startRotate}>
          <svg width={11} height={11} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2" />
          </svg>
        </span>
      </div>
    </>
  )
}
