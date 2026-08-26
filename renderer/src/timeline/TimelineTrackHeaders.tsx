import { useRef, useState } from 'react'
import type { TimelineTrack } from '@shared/timelineTracks'
import { useSequence } from '../sequence/SequenceContext'
import { useTimelineView } from './TimelineViewContext'
import { sortTracksForDisplay, trackDisplayHeight } from './trackModel'
import { TrackHeaderMenu } from './TrackHeaderMenu'
import { EyeIcon, LockIcon, VolumeIcon, VideoTrackIcon, AudioTrackIcon, GraphicTrackIcon, TextTrackIcon, CaptionTrackIcon } from '../nav/icons'
import type { TimelineTrackKind } from '@shared/timelineTracks'

/** Kinds that can actually carry audio (a video's own embedded track, or a
 * dedicated audio track) -- these get the Mute speaker icon; graphic/text/
 * caption tracks never do. */
const AUDIBLE_KINDS: readonly TimelineTrackKind[] = ['video', 'audio']
/** Kinds with something visual to show/hide -- everything except pure audio. */
const VISUAL_KINDS: readonly TimelineTrackKind[] = ['video', 'graphic', 'text', 'caption']

function TrackKindIcon({ kind }: { kind: TimelineTrackKind }): JSX.Element {
  switch (kind) {
    case 'video':
      return <VideoTrackIcon />
    case 'audio':
      return <AudioTrackIcon />
    case 'graphic':
      return <GraphicTrackIcon />
    case 'text':
      return <TextTrackIcon />
    case 'caption':
      return <CaptionTrackIcon />
  }
}

interface Props {
  tracks: TimelineTrack[]
  /** Which tracks currently have any clips/scenes on them -- gates the
   * "confirm before deleting a non-empty track" behavior in the "..." menu. */
  trackHasContent: Record<string, boolean>
}

/** One row shape for every track kind, parameterized by `track.kind` for
 * which extra controls render (mute/solo chips are audio-only) -- replaces
 * the old two separate hardcoded row components (HeaderRow/AudioHeaderRow).
 * The "..." menu (and the ability to add a sibling above/below) is hidden
 * for the one fixed caption track, which has no siblings and can't be
 * deleted/duplicated (see shared/timelineTracks.ts's `removable`). */
function UnifiedTrackHeader({ track, hasContent }: { track: TimelineTrack; hasContent: boolean }): JSX.Element {
  const { toggleTrackFlag, addTrackAt, duplicateTrack, renameTrack, removeTrack, reorderTrack } = useSequence()
  const { trackHeightMode } = useTimelineView()
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(track.name)
  const rowRef = useRef<HTMLDivElement>(null)

  // Right-click anywhere on the row opens the SAME "..." menu (spec section
  // 11: "Track menu: same items as existing '...' menu") -- rather than a
  // second, parallel menu implementation, this just finds and clicks the
  // existing trigger button.
  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const trigger = rowRef.current?.querySelector<HTMLButtonElement>('[title="Track options"]')
    trigger?.click()
  }

  const commitRename = (): void => {
    setEditingName(false)
    if (nameDraft.trim() && nameDraft.trim() !== track.name) renameTrack(track.id, nameDraft.trim())
  }

  if (editingName) {
    return (
      <div
        className={`timeline-header-row${track.locked ? ' timeline-header-row-locked' : ''}`}
        style={{ height: trackDisplayHeight(track, trackHeightMode) }}
        ref={rowRef}
      >
        <input
          className="timeline-header-label-input"
          autoFocus
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setNameDraft(track.name)
              setEditingName(false)
            }
          }}
        />
      </div>
    )
  }

  // Compact, icon-only row (no visible name label) -- the track name is
  // still reachable via the row's own tooltip and the "..." menu's Rename
  // item, matching the reference editor's narrow icon-strip header exactly
  // instead of the wider text-label-forward header this used to be.
  return (
    <div
      className={`timeline-header-row${track.locked ? ' timeline-header-row-locked' : ''}`}
      style={{ height: trackDisplayHeight(track, trackHeightMode) }}
      ref={rowRef}
      title={track.name}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => setEditingName(true)}
    >
      <span className="timeline-header-kind-icon" title={track.kind}>
        <TrackKindIcon kind={track.kind} />
      </span>
      <span className="timeline-header-spring" />
      {AUDIBLE_KINDS.includes(track.kind) && (
        <button
          className={track.muted ? 'timeline-header-icon timeline-header-icon-active' : 'timeline-header-icon'}
          title={track.muted ? 'Unmute' : 'Mute'}
          onClick={(e) => {
            e.stopPropagation()
            toggleTrackFlag(track.id, 'muted')
          }}
        >
          <VolumeIcon size={13} muted={track.muted} />
        </button>
      )}
      {VISUAL_KINDS.includes(track.kind) && (
        <button
          className="timeline-header-icon"
          title={track.hidden ? 'Show' : 'Hide'}
          onClick={(e) => {
            e.stopPropagation()
            toggleTrackFlag(track.id, 'hidden')
          }}
        >
          <EyeIcon open={!track.hidden} />
        </button>
      )}
      <button
        className="timeline-header-icon"
        title={track.locked ? 'Unlock track' : 'Lock track'}
        onClick={(e) => {
          e.stopPropagation()
          toggleTrackFlag(track.id, 'locked')
        }}
      >
        <LockIcon locked={track.locked} />
      </button>
      {track.removable && (
        <TrackHeaderMenu
          track={track}
          hasContent={hasContent}
          solo={!!track.solo}
          onToggleSolo={AUDIBLE_KINDS.includes(track.kind) ? () => toggleTrackFlag(track.id, 'solo') : undefined}
          onAddAbove={() => addTrackAt(track.kind, track.id, 'above')}
          onAddBelow={() => addTrackAt(track.kind, track.id, 'below')}
          onDuplicate={() => duplicateTrack(track.id)}
          onRename={() => setEditingName(true)}
          onDelete={() => removeTrack(track.id)}
          onMoveUp={() => reorderTrack(track.id, 'up')}
          onMoveDown={() => reorderTrack(track.id, 'down')}
        />
      )}
    </div>
  )
}

export function TimelineTrackHeaders({ tracks, trackHasContent }: Props): JSX.Element {
  return (
    <div className="timeline-headers">
      <div className="timeline-header-spacer" />
      {sortTracksForDisplay(tracks).map((track) => (
        <UnifiedTrackHeader key={track.id} track={track} hasContent={trackHasContent[track.id] ?? false} />
      ))}
    </div>
  )
}
