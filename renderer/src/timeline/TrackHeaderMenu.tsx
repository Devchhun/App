import { useEffect, useRef, useState } from 'react'
import type { TimelineTrack } from '@shared/timelineTracks'
import { MenuDotsIcon } from '../nav/icons'

interface Props {
  track: TimelineTrack
  hasContent: boolean
  /** Only rendered as a menu item for audible track kinds (video/audio) --
   * the header row itself only has room for Mute as a dedicated icon (see
   * TimelineTrackHeaders.tsx), Solo lives here instead. */
  solo?: boolean
  onToggleSolo?: () => void
  onAddAbove: () => void
  onAddBelow: () => void
  onDuplicate: () => void
  onRename: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

/** Track header "..." menu -- Add Track Above/Below, Duplicate, Rename,
 * Delete (with confirmation if the track isn't empty), Move Up/Down. Not
 * rendered at all for the one fixed, non-removable caption track (see
 * TimelineTrackHeaders.tsx) -- it has no siblings to add/reorder relative to
 * and can't be deleted or duplicated. Same self-contained popover pattern as
 * AddTrackButton.tsx. */
export function TrackHeaderMenu({ track, hasContent, solo, onToggleSolo, onAddAbove, onAddBelow, onDuplicate, onRename, onDelete, onMoveUp, onMoveDown }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const run = (action: () => void): void => {
    action()
    setOpen(false)
  }

  const handleDelete = (): void => {
    if (hasContent && !window.confirm(`Delete "${track.name}"? This track has clips/scenes on it that will be removed too.`)) return
    run(onDelete)
  }

  return (
    <div className="track-menu-root" ref={rootRef}>
      <button className="timeline-header-icon" title="Track options" onClick={() => setOpen((v) => !v)}>
        <MenuDotsIcon />
      </button>
      {open && (
        <div className="track-menu-popover track-menu-popover-right">
          {onToggleSolo && (
            <button className="track-menu-item" onClick={() => run(onToggleSolo)}>
              {solo ? 'Unsolo' : 'Solo'}
            </button>
          )}
          <button className="track-menu-item" onClick={() => run(onAddAbove)}>
            Add Track Above
          </button>
          <button className="track-menu-item" onClick={() => run(onAddBelow)}>
            Add Track Below
          </button>
          <button className="track-menu-item" onClick={() => run(onDuplicate)}>
            Duplicate Track
          </button>
          <button className="track-menu-item" onClick={() => run(onRename)}>
            Rename Track
          </button>
          <button className="track-menu-item" onClick={() => run(onMoveUp)}>
            Move Up
          </button>
          <button className="track-menu-item" onClick={() => run(onMoveDown)}>
            Move Down
          </button>
          <button className="track-menu-item track-menu-item-danger" onClick={handleDelete}>
            Delete Track
          </button>
        </div>
      )}
    </div>
  )
}
