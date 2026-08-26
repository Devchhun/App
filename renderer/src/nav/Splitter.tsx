import { useCallback, useRef, type CSSProperties } from 'react'

interface Props {
  /** Current pixel size (width for axis 'x', height for axis 'y') of the
   * panel this splitter resizes. */
  width: number
  onChange: (px: number) => void
  onReset: () => void
  /** Which side of the splitter the resized panel is on -- determines
   * whether a pointer delta grows or shrinks it. 'left'/'right' for a
   * vertical divider (axis 'x', the default); 'top'/'bottom' for a
   * horizontal divider (axis 'y'). */
  side: 'left' | 'right' | 'top' | 'bottom'
  /** 'x' (default): vertical divider, resizes width, reads clientX.
   * 'y': horizontal divider, resizes height, reads clientY -- e.g. the
   * Timeline panel's own height handle. */
  axis?: 'x' | 'y'
  /** Absolute-position overlay placement -- the splitter is not a grid track
   * and consumes no layout width/height, so the panels it sits between can
   * touch directly. */
  style: CSSProperties
}

/** A draggable divider between two panels, overlaid on top of the 1px panel-
 * border rather than occupying its own layout space. Pointer-capture based
 * (same pattern as the graphics selection handles), so dragging keeps
 * working even if the cursor leaves the thin hit area. Double-click resets
 * the panel to its default size. */
export function Splitter({ width, onChange, onReset, side, axis = 'x', style }: Props): JSX.Element {
  const dragRef = useRef<{ start: number; startSize: number } | null>(null)

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = { start: axis === 'x' ? e.clientX : e.clientY, startSize: width }
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    },
    [width, axis]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const delta = (axis === 'x' ? e.clientX : e.clientY) - drag.start
      // 'left'/'top' panel: dragging right/down grows it. 'right'/'bottom': the opposite.
      const grows = side === 'left' || side === 'top'
      onChange(grows ? drag.startSize + delta : drag.startSize - delta)
    },
    [onChange, side, axis]
  )

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    if ((e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) {
      ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
    }
  }, [])

  return (
    <div
      className={axis === 'y' ? 'workspace-splitter workspace-splitter-horizontal' : 'workspace-splitter'}
      style={style}
      role="separator"
      aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
      title="Drag to resize, double-click to reset"
    />
  )
}
