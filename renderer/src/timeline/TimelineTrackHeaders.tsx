import { useCallback, useRef, useState } from 'react'
import type { TimelineTrack } from '@shared/timelineTracks'
import { useSequence } from '../sequence/SequenceContext'
import { useScenes } from '../scenes/SceneContext'
import { useHistory } from '../history/HistoryContext'
import { useTimelineView } from './TimelineViewContext'
import { sortTracksForDisplay, trackDisplayHeight } from './trackModel'
import { TrackHeaderMenu } from './TrackHeaderMenu'
import { EyeIcon, LockIcon, VolumeIcon, VideoTrackIcon, AudioTrackIcon, GraphicTrackIcon, TextTrackIcon, CaptionTrackIcon } from '../nav/icons'
import type { TimelineTrackKind } from '@shared/timelineTracks'
import { useConfirm } from '../ui/ConfirmDialog'
import { useProject } from '../project/ProjectContext'
import { usePlaybackControls } from '../playback/PlaybackContext'

/** Kinds that can actually carry audio (a video's own embedded track, or a
 * dedicated audio track) -- these get the Mute speaker icon; graphic/text/
 * caption tracks never do. */
const AUDIBLE_KINDS: readonly TimelineTrackKind[] = ['video', 'audio']
/** Kinds with something visual to show/hide -- everything except pure audio. */
const VISUAL_KINDS: readonly TimelineTrackKind[] = ['video', 'graphic', 'text', 'caption']

function TrackKindIcon({ kind }: { kind: TimelineTrackKind }): JSX.Element {
  switch (kind) {
    case 'video':
      return <VideoTrackIcon size={16} />
    case 'audio':
      return <AudioTrackIcon size={16} />
    case 'graphic':
      return <GraphicTrackIcon size={16} />
    case 'text':
      return <TextTrackIcon size={16} />
    case 'caption':
      return <CaptionTrackIcon size={16} />
  }
}

interface Props {
  tracks: TimelineTrack[]
  /** Display-only kind override for legacy tracks whose saved kind predates
   * dedicated text tracks (e.g. an old Add Text lower-third on a graphic
   * row). It changes only the glyph, never project data. */
  iconKindByTrackId?: Record<string, TimelineTrackKind>
  /** Which tracks currently have any clips/scenes on them -- gates the
   * "confirm before deleting a non-empty track" behavior in the "..." menu. */
  trackHasContent: Record<string, boolean>
  /** Matches Timeline.tsx's own computeTrackCentering result exactly -- the
   * header column and the content column are separate sibling elements (see
   * Timeline.tsx's `.timeline-header-column` / `.timeline-content-column`),
   * each scrolling together but laid out independently, so without this the
   * header rows would stack right after the ruler while the actual track
   * rows they're supposed to label sit lower, centered around the main
   * track -- every row would point at the wrong track. */
  topSpacerHeight: number
  /** The other half of that same centering result. Without it this column
   * ended right below its last header row while the content column beside
   * it kept going for another `bottomSpacerHeight` -- so the header strip's
   * own background simply stopped partway down, leaving a bare unfilled
   * band under it, and (because `.timeline-scroll-2d` lays the two columns
   * out as flex-start siblings) the short column had less height to scroll
   * through than the tall one next to it. */
  bottomSpacerHeight: number
}

/** One row shape for every track kind, parameterized by `track.kind` for
 * which extra controls render (mute/solo chips are audio-only) -- replaces
 * the old two separate hardcoded row components (HeaderRow/AudioHeaderRow).
 * The "..." menu (and the ability to add a sibling above/below) is hidden
 * for the one fixed caption track, which has no siblings and can't be
 * deleted/duplicated (see shared/timelineTracks.ts's `removable`). */
function UnifiedTrackHeader({ track, hasContent, iconKind }: { track: TimelineTrack; hasContent: boolean; iconKind?: TimelineTrackKind }): JSX.Element {
  const { toggleTrackFlag, addTrackAt, duplicateTrack, renameTrack, removeTrack, reorderTrack } = useSequence()
  const { scenesByMedia, deleteScene } = useScenes()
  const { beginTransaction, endTransaction } = useHistory()
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

  // "Delete Track"'s own confirmation dialog (TrackHeaderMenu.tsx) already
  // promises "clips/scenes on it that will be removed too" -- removeTrack
  // itself now sweeps up clips (SequenceContext.tsx), but Scenes live in a
  // wholly separate context/state tree (keyed by mediaId, not trackId), so
  // that removal can't reach them. Swept here instead, and wrapped in one
  // transaction so deleting a track with scenes on it is still a single
  // Undo step, not one per scene plus a separate one for the track.
  const handleDeleteTrack = useCallback(() => {
    beginTransaction()
    for (const [mediaId, scenes] of Object.entries(scenesByMedia)) {
      for (const scene of scenes) {
        if (scene.track === track.id) deleteScene(mediaId, scene.id)
      }
    }
    removeTrack(track.id)
    endTransaction()
  }, [scenesByMedia, deleteScene, removeTrack, track.id, beginTransaction, endTransaction])

  const commitRename = (): void => {
    setEditingName(false)
    if (nameDraft.trim() && nameDraft.trim() !== track.name) renameTrack(track.id, nameDraft.trim())
  }

  if (editingName) {
    return (
      <div
        className={`timeline-header-row${track.locked ? ' timeline-header-row-locked' : ''}${track.isMain ? ' timeline-header-row-sticky-main' : ''}`}
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
      className={`timeline-header-row${track.locked ? ' timeline-header-row-locked' : ''}${track.isMain ? ' timeline-header-row-sticky-main' : ''}`}
      style={{ height: trackDisplayHeight(track, trackHeightMode) }}
      ref={rowRef}
      title={track.name}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => setEditingName(true)}
    >
      <span className="timeline-header-kind-icon" title={iconKind ?? track.kind}>
        <TrackKindIcon kind={iconKind ?? track.kind} />
      </span>
      {/* CapCut's order and spacing: kind, lock, eye, speaker, menu --
          spread evenly across the header so every row's icons line up in
          columns, with an empty slot where a kind has no eye/speaker. */}
      <button
        className="timeline-header-icon"
        title={track.locked ? 'Unlock track' : 'Lock track'}
        onClick={(e) => {
          e.stopPropagation()
          toggleTrackFlag(track.id, 'locked')
        }}
      >
        <LockIcon locked={track.locked} size={16} />
      </button>
      {VISUAL_KINDS.includes(track.kind) ? (
        <button
          className="timeline-header-icon"
          title={track.hidden ? 'Show' : 'Hide'}
          onClick={(e) => {
            e.stopPropagation()
            toggleTrackFlag(track.id, 'hidden')
          }}
        >
          <EyeIcon open={!track.hidden} size={16} />
        </button>
      ) : (
        <span className="timeline-header-icon timeline-header-icon-slot" aria-hidden />
      )}
      {AUDIBLE_KINDS.includes(track.kind) ? (
        <button
          className={track.muted ? 'timeline-header-icon timeline-header-icon-active' : 'timeline-header-icon'}
          title={track.muted ? 'Unmute' : 'Mute'}
          onClick={(e) => {
            e.stopPropagation()
            toggleTrackFlag(track.id, 'muted')
          }}
        >
          <VolumeIcon size={16} muted={track.muted} />
        </button>
      ) : (
        <span className="timeline-header-icon timeline-header-icon-slot" aria-hidden />
      )}
      {!track.removable && <span className="timeline-header-icon timeline-header-icon-slot" aria-hidden />}
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
          onDelete={handleDeleteTrack}
          onMoveUp={() => reorderTrack(track.id, 'up')}
          onMoveDown={() => reorderTrack(track.id, 'down')}
        />
      )}
    </div>
  )
}

export function TimelineTrackHeaders({ tracks, iconKindByTrackId, trackHasContent, topSpacerHeight, bottomSpacerHeight }: Props): JSX.Element {
  return (
    <div className="timeline-headers">
      {/* The Cover tab lives in the corner above the headers, where it
          never sits on top of a clip's first seconds. */}
      <div className="timeline-header-ruler-spacer">
        <CoverButton />
      </div>
      <div className="timeline-header-safe-zone-spacer" />
      <div className="timeline-tracks-spacer" style={{ height: topSpacerHeight }} />
      {sortTracksForDisplay(tracks).map((track) => (
        <UnifiedTrackHeader key={track.id} track={track} iconKind={iconKindByTrackId?.[track.id]} hasContent={trackHasContent[track.id] ?? false} />
      ))}
      {/* Mirrors the content column's own trailing spacer (Timeline.tsx), so
          both columns come out exactly the same height -- see the prop's own
          doc comment. Also gives the sticky main-track header row the same
          run of parent height its content-side counterpart has to stay
          pinned through. */}
      <div className="timeline-tracks-spacer" style={{ height: bottomSpacerHeight }} />
    </div>
  )
}

/** CapCut's "Cover" tab: the frame under the playhead becomes the
 * project's cover -- the picture its Home card
 * shows. Saved as a PNG beside the app's other generated files. */
function CoverButton(): JSX.Element {
  const { captureFrame } = usePlaybackControls()
  const { projectId, setCover } = useProject()
  const confirm = useConfirm()
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setCoverFromPlayhead = async (): Promise<void> => {
    if (status === 'saving') return
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    setStatus('saving')
    try {
      const dataUrl = captureFrame()
      if (!dataUrl) {
        setStatus('error')
        await confirm({
          title: 'No frame for the cover',
          message: 'Move the playhead onto a visible video or image frame in Project Preview, then press Cover again.',
          confirmLabel: 'OK',
          hideCancel: true
        })
        return
      }
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const savedPath = await window.api.media.saveGeneratedFile(`cover-${projectId ?? 'project'}.png`, bytes)
      setCover(savedPath)
      setStatus('saved')
      await confirm({
        title: 'Project cover updated',
        message: 'The frame under the playhead is now this project’s cover on the Home screen.',
        confirmLabel: 'OK',
        hideCancel: true
      })
    } catch (error) {
      setStatus('error')
      await confirm({
        title: 'Could not set cover',
        message: error instanceof Error ? error.message : 'The current frame could not be saved. Please try another frame.',
        confirmLabel: 'OK',
        hideCancel: true
      })
    } finally {
      resetTimerRef.current = setTimeout(() => setStatus('idle'), 1800)
    }
  }

  return (
    <button
      type="button"
      className={`timeline-cover-button timeline-cover-button-${status}`}
      title="Set this frame as the project cover (shown on the Home screen)"
      disabled={status === 'saving'}
      aria-live="polite"
      onClick={(e) => {
        e.stopPropagation()
        void setCoverFromPlayhead()
      }}
    >
      <svg width={13} height={13} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 14.5V16h1.5L15 6.5 13.5 5zM11.5 7l1.5 1.5" />
      </svg>
      {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Cover set' : status === 'error' ? 'Try again' : 'Cover'}
    </button>
  )
}
