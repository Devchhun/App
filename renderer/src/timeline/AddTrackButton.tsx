import { useEffect, useRef, useState } from 'react'
import type { TimelineTrackKind } from '@shared/timelineTracks'
import { PlusIcon } from '../nav/icons'

interface Props {
  onAdd: (kind: TimelineTrackKind) => void
}

// Text isn't offered -- there's no distinct text-clip entity yet, every
// on-screen text/lower-third/etc. is a Scene routed as kind 'graphic' (see
// TemplateBrowserPanel.tsx). The fixed caption track isn't offered either --
// there's exactly one, non-duplicatable (see shared/timelineTracks.ts).
const OPTIONS: { kind: TimelineTrackKind; label: string }[] = [
  { kind: 'video', label: 'Video Track' },
  { kind: 'graphic', label: 'Graphic Track' },
  { kind: 'audio', label: 'Audio Track' }
]

/** "+ Add Track" toolbar button with a small kind-picker popover. Self-
 * contained (own open/close state, closes on outside click) rather than a
 * shared Popover abstraction -- this and the track header's "..." menu
 * (TrackHeaderMenu.tsx) are the only two menus in the app so far. */
export function AddTrackButton({ onAdd }: Props): JSX.Element {
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

  return (
    <div className="track-menu-root" ref={rootRef}>
      <button className="timeline-tool-button timeline-add-track-button" title="Add Track" onClick={() => setOpen((v) => !v)}>
        <PlusIcon size={12} /> Track
      </button>
      {open && (
        <div className="track-menu-popover">
          {OPTIONS.map((o) => (
            <button
              key={o.kind}
              className="track-menu-item"
              onClick={() => {
                onAdd(o.kind)
                setOpen(false)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
