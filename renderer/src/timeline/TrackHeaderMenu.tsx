import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TimelineTrack } from '@shared/timelineTracks'
import { MenuDotsIcon } from '../nav/icons'
import { useConfirm } from '../ui/ConfirmDialog'

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
  const confirm = useConfirm()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false })

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // The menu is anchored to a scrolling row. Closing on scroll avoids a
    // detached popover floating where the trigger used to be.
    const handleViewportChange = (): void => setOpen(false)
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !anchorRect || !popoverRef.current) return
    const menu = popoverRef.current.getBoundingClientRect()
    const margin = 4
    const left = Math.max(margin, Math.min(anchorRect.right - menu.width, window.innerWidth - menu.width - margin))
    const below = anchorRect.bottom + margin
    const top =
      below + menu.height <= window.innerHeight - margin
        ? below
        : Math.max(margin, anchorRect.top - menu.height - margin)
    setPosition({ left, top, ready: true })
  }, [open, anchorRect])

  const handleToggle = (): void => {
    if (!open && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect())
      setPosition((current) => ({ ...current, ready: false }))
    }
    setOpen((current) => !current)
  }

  const run = (action: () => void): void => {
    action()
    setOpen(false)
  }

  const handleDelete = async (): Promise<void> => {
    if (hasContent) {
      const confirmed = await confirm({
        title: `Delete "${track.name}"?`,
        message: 'This track has clips or scenes on it, which will be removed too.',
        confirmLabel: 'Delete track',
        danger: true
      })
      if (!confirmed) return
    }
    run(onDelete)
  }

  return (
    <div className="track-menu-root" ref={rootRef}>
      <button ref={buttonRef} className="timeline-header-icon" title="Track options" aria-expanded={open} onClick={handleToggle}>
        <MenuDotsIcon size={16} />
      </button>
      {open &&
        createPortal(
        <div
          ref={popoverRef}
          className="track-menu-popover track-menu-popover-fixed"
          style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
          role="menu"
        >
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
          <button className="track-menu-item track-menu-item-danger" onClick={() => void handleDelete()}>
            Delete Track
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
