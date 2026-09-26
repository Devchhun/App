import { useEffect, useRef, useState } from 'react'
import type { TimelineTool } from './timelineViewPrefs'
import { SelectionArrowIcon, ScissorsIcon, HandToolIcon, RangeToolIcon, RollEditIcon, ChevronDownIcon } from '../nav/icons'

interface Props {
  tool: TimelineTool
  onChange: (tool: TimelineTool) => void
}

const OPTIONS: { tool: TimelineTool; label: string; shortcut: string; icon: JSX.Element }[] = [
  { tool: 'select', label: 'Select', shortcut: 'A', icon: <SelectionArrowIcon /> },
  { tool: 'blade', label: 'Blade', shortcut: 'B', icon: <ScissorsIcon /> },
  { tool: 'hand', label: 'Hand', shortcut: 'H', icon: <HandToolIcon /> },
  { tool: 'range', label: 'Range select', shortcut: 'R', icon: <RangeToolIcon /> },
  { tool: 'roll', label: 'Roll edit', shortcut: '', icon: <RollEditIcon /> }
]

/** Current-tool button with a dropdown to pick Select/Blade/Hand/Range/Roll
 * -- same self-contained popover pattern as AddTrackButton.tsx/
 * TrackHeaderMenu.tsx (own open state, closes on outside click). The icon
 * always shows the CURRENT tool, and any click on the button opens the
 * picker (there's no separate large hit target to spare for a second
 * behavior at this size). */
export function SelectionToolButton({ tool, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = OPTIONS.find((o) => o.tool === tool) ?? OPTIONS[0]

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="track-menu-root" ref={rootRef}>
      <button
        className={tool !== 'select' ? 'timeline-tool-button timeline-tool-button-active timeline-tool-button-wide' : 'timeline-tool-button timeline-tool-button-wide'}
        title={current.shortcut ? `${current.label} (${current.shortcut})` : current.label}
        aria-label={current.label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-trigger-icon">{current.icon}</span>
        <ChevronDownIcon size={9} />
      </button>
      {open && (
        <div className="track-menu-popover tool-menu" role="menu">
          {OPTIONS.map((o) => (
            <button
              key={o.tool}
              role="menuitemradio"
              aria-checked={o.tool === tool}
              className={o.tool === tool ? 'tool-menu-item tool-menu-item-active' : 'tool-menu-item'}
              onClick={() => {
                onChange(o.tool)
                setOpen(false)
              }}
            >
              <span className="tool-menu-icon">{o.icon}</span>
              <span className="tool-menu-label">{o.label}</span>
              {o.shortcut && <kbd className="tool-menu-key">{o.shortcut}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
