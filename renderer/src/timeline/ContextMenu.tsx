import { useEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  /** Renders a thin divider instead of a clickable item -- `label`/`onClick` are ignored. */
  separator?: boolean
}

interface Props {
  /** Viewport (clientX/clientY) coordinates -- e.g. straight from a
   * `contextmenu` event. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/** Cursor-positioned context menu (spec section 11) -- clip/track/ruler/
 * empty-space right-click menus. Shares its visual language
 * (.track-menu-popover/.track-menu-item) with the existing button-anchored
 * menus (TrackHeaderMenu.tsx, AddTrackButton.tsx) via `.context-menu-popover`,
 * which is identical except `position: fixed` with an inline left/top
 * instead of being anchored to a parent's `position: relative`. Clamps
 * itself to stay within the viewport, closes on outside click or Escape,
 * and supports Up/Down/Enter keyboard navigation between items. */
export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Measure-then-clamp: renders once at the raw cursor position (off-screen
  // if needed), then repositions itself to stay fully within the viewport --
  // matches "must stay within visible window" (spec section 11).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    setPos({ left, top, ready: true })
    el.focus()
  }, [x, y])

  const enabledIndices = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0)

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (enabledIndices.length === 0) return
      const curPos = enabledIndices.indexOf(activeIndex)
      const nextPos = e.key === 'ArrowDown' ? (curPos + 1) % enabledIndices.length : (curPos - 1 + enabledIndices.length) % enabledIndices.length
      setActiveIndex(enabledIndices[nextPos])
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      const item = items[activeIndex]
      item.onClick?.()
      onClose()
    }
  }

  return (
    <div
      ref={rootRef}
      className="context-menu-popover"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      role="menu"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-separator" />
        ) : (
          <button
            key={i}
            className={`track-menu-item${item.danger ? ' track-menu-item-danger' : ''}${activeIndex === i ? ' context-menu-item-active' : ''}`}
            disabled={item.disabled}
            role="menuitem"
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => {
              item.onClick?.()
              onClose()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
