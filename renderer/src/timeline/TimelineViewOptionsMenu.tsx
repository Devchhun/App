import { useEffect, useRef, useState } from 'react'
import { MenuDotsIcon } from '../nav/icons'
import type { TrackHeightMode } from './TimelineViewContext'

interface Props {
  showWaveforms: boolean
  onToggleShowWaveforms: () => void
  trackHeightMode: TrackHeightMode
  onSetTrackHeightMode: (mode: TrackHeightMode) => void
  skimmerOn: boolean
  onToggleSkimmer: () => void
  onCollapseAll: () => void
  onExpandAll: () => void
}

const HEIGHT_MODES: { mode: TrackHeightMode; label: string }[] = [
  { mode: 'compact', label: 'Compact' },
  { mode: 'normal', label: 'Normal' },
  { mode: 'tall', label: 'Tall' }
]

/** "Timeline View options" toolbar item -- show-waveforms, track-height mode
 * (Compact/Normal/Tall, spec section 15), and the hover skimmer toggle (spec
 * section 7), plus collapse/expand-all, which naturally belongs alongside
 * per-track display options. Same self-contained popover pattern as
 * AddTrackButton.tsx. */
export function TimelineViewOptionsMenu({
  showWaveforms,
  onToggleShowWaveforms,
  trackHeightMode,
  onSetTrackHeightMode,
  skimmerOn,
  onToggleSkimmer,
  onCollapseAll,
  onExpandAll
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Anchored via measured viewport coordinates + position:fixed (matching
  // ContextMenu.tsx) rather than position:absolute/top:100% relative to the
  // trigger -- this toolbar sits right at the boundary between the Preview
  // and Timeline panels, and an absolutely-positioned popover there can end
  // up visually painted UNDER the Timeline panel's own content (a real,
  // reproducible stacking-context issue in a project with enough tracks
  // that the popover's height extends past the Preview panel's own
  // bounds), making its items unclickable despite z-index:20. Fixed
  // positioning escapes that ancestor-relative stacking entirely.
  const [pos, setPos] = useState({ top: 0, right: 0 })

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleToggle = (): void => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom, right: window.innerWidth - rect.right })
    }
    setOpen((v) => !v)
  }

  return (
    <div className="track-menu-root" ref={rootRef}>
      <button ref={buttonRef} className="timeline-tool-button" title="Timeline view options" aria-label="Timeline view options" onClick={handleToggle}>
        <MenuDotsIcon size={14} />
      </button>
      {open && (
        <div className="track-menu-popover track-menu-popover-fixed" style={{ top: pos.top, right: pos.right }}>
          <button className="track-menu-item" onClick={onToggleShowWaveforms}>
            {showWaveforms ? '✓ ' : ''}Show waveforms
          </button>
          <div className="context-menu-separator" />
          {HEIGHT_MODES.map((h) => (
            <button key={h.mode} className="track-menu-item" onClick={() => onSetTrackHeightMode(h.mode)}>
              {trackHeightMode === h.mode ? '✓ ' : ''}
              {h.label} track height
            </button>
          ))}
          <div className="context-menu-separator" />
          <button className="track-menu-item" onClick={onToggleSkimmer}>
            {skimmerOn ? '✓ ' : ''}Hover skimmer
          </button>
          <button
            className="track-menu-item"
            onClick={() => {
              onCollapseAll()
              setOpen(false)
            }}
          >
            Collapse all tracks
          </button>
          <button
            className="track-menu-item"
            onClick={() => {
              onExpandAll()
              setOpen(false)
            }}
          >
            Expand all tracks
          </button>
        </div>
      )}
    </div>
  )
}
