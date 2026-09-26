import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { useMedia } from './MediaContext'
import { MediaListItem } from './MediaListItem'
import { FilterIcon, GridViewIcon, ListViewIcon, TrashIcon } from '../nav/icons'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { usePlaybackControls } from '../playback/PlaybackContext'
import { assetFromMediaItem } from './assetFromMediaItem'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { useConfirm } from '../ui/ConfirmDialog'
import { DEFAULT_IMAGE_DURATION_SECONDS } from '../sequence/sequenceOps'
import type { MediaItem, MediaKind } from '@shared/media'
import { MEDIA_DRAG_MIME_TYPE, setCurrentDragMediaIds, type MediaDragPayload } from './mediaDragPayload'

type KindFilter = 'all' | MediaKind
type SortBy = 'recent' | 'name'
type ViewMode = 'grid' | 'list'

export function ImportPanel(): JSX.Element {
  const { items, importPaths, ffmpegStatus, selectedId, select, selectedIds, selectMedia, selectAllMedia, clearMediaSelection, cancel, retry, removeMedia } = useMedia()
  const { sequence, insertClip, ensureTrack, selectClips, deleteSelected } = useSequence()
  const confirm = useConfirm()
  const { beginTransaction, endTransaction } = useHistory()
  const { getCurrentTime } = usePlaybackControls()
  const [isDragOver, setIsDragOver] = useState(false)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [sortBy, setSortBy] = useState<SortBy>('recent')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')

  const ffmpegUnavailable = ffmpegStatus !== null && (!ffmpegStatus.ffmpeg || !ffmpegStatus.ffprobe)

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragOver(false)
      if (ffmpegUnavailable) return
      const paths = Array.from(e.dataTransfer.files)
        .map((file) => window.api.media.getPathForFile(file))
        .filter((path): path is string => Boolean(path))
      if (paths.length > 0) await importPaths(paths)
    },
    [importPaths, ffmpegUnavailable]
  )

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase()
    const filtered = items.filter((item) => {
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false
      if (term && !item.fileName.toLowerCase().includes(term)) return false
      return true
    })
    const sorted = [...filtered]
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.fileName.localeCompare(b.fileName))
    } else {
      sorted.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    }
    return sorted
  }, [items, kindFilter, search, sortBy])

  // "Add to Timeline" (double-click / button) always lands exactly at the
  // current playhead -- matching every other manual insertion point in this
  // app (Templates, Voiceover Recorder) and the explicit requirement that a
  // new item's real startTime equals wherever the playhead currently is, not
  // some computed "after the last clip" position. Still auto-routes around
  // whatever's already occupying that time (findOrCreateTrack) so it lands
  // on a free/new track instead of overlapping an existing clip on the same
  // track -- clicking "+" repeatedly without moving the playhead stacks
  // items vertically (separate tracks, same start time) rather than
  // chaining them forward in time; that's the deliberate tradeoff of
  // "always at the playhead," not a bug.
  // The card's own onDoubleClick and the "+" button nested inside it (see
  // MediaListItem.tsx) both call this -- a real double-click on the button
  // fires two native 'click' events (each independently reaching here)
  // *plus* a 'dblclick' that still bubbles up to the card even though the
  // button's onClick calls stopPropagation (that only stops 'click' from
  // bubbling, not the separate 'dblclick' event), so one double-click was
  // silently inserting the same item three times. A "double-click to add"
  // affordance should only ever produce one insertion, so the same item
  // within this window is treated as one user action, not several.
  const lastAddRef = useRef<{ id: string; at: number } | null>(null)

  const handleAddToTimeline = useCallback(
    (item: MediaItem) => {
      const last = lastAddRef.current
      const now = Date.now()
      if (last && last.id === item.id && now - last.at < 500) return
      lastAddRef.current = { id: item.id, at: now }

      const isAudio = item.assetType === 'audio' || (item.kind === 'audio' && item.assetType !== 'video')
      const kind = isAudio ? 'audio' : 'video'
      const duration = item.assetType === 'image' ? DEFAULT_IMAGE_DURATION_SECONDS : (item.metadata?.durationSeconds ?? DEFAULT_IMAGE_DURATION_SECONDS)
      const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
      const currentTime = getCurrentTime()
      const routing = findOrCreateTrack(sequence.tracks, occupied, currentTime, duration, kind)
      if (routing.newTrack) ensureTrack(routing.newTrack)
      insertClip(assetFromMediaItem(item), currentTime, routing.trackId)
    },
    [insertClip, getCurrentTime, sequence.clips, sequence.tracks, ensureTrack]
  )

  // Removing an item never touches its real source file on disk (this app
  // never deletes user files, only its own reference to them) -- lets a
  // stray/mistaken import, or leftover test/experimental media, be cleared
  // out of the project without editing the project file by hand. Mirrors
  // TrackHeaderMenu's own "Delete Track" confirmation exactly: silent when
  // nothing depends on it, and the app's own confirm dialog (see
  // ui/ConfirmDialog.tsx) when Timeline clips still reference it, since
  // deleting the media out from under them would otherwise leave broken
  // clips behind.
  const handleRemoveMedia = useCallback(
    async (item: MediaItem) => {
      const referencingClipIds = sequence.clips.filter((c) => c.mediaId === item.id).map((c) => c.id)
      if (referencingClipIds.length > 0) {
        const clipWord = referencingClipIds.length === 1 ? 'clip' : 'clips'
        const confirmed = await confirm({
          title: `Remove "${item.fileName}"?`,
          message: `It's used in ${referencingClipIds.length} ${clipWord} on the Timeline, which will be removed too. The file on disk is not deleted.`,
          confirmLabel: 'Remove',
          danger: true
        })
        if (!confirmed) return
        beginTransaction()
        selectClips(referencingClipIds)
        deleteSelected()
        endTransaction()
      }
      removeMedia(item.id)
    },
    [sequence.clips, beginTransaction, endTransaction, selectClips, deleteSelected, removeMedia, confirm]
  )

  // Bulk version for the multi-selection: one confirmation for the lot
  // (always, even when nothing on the Timeline uses them -- removing many
  // items at once is worth a second look), one history entry for any
  // Timeline clips that go with them.
  const handleRemoveSelected = useCallback(async () => {
    const targets = items.filter((item) => selectedIds.includes(item.id))
    if (targets.length === 0) return
    const targetIds = new Set(targets.map((t) => t.id))
    const referencingClipIds = sequence.clips.filter((c) => targetIds.has(c.mediaId)).map((c) => c.id)
    const itemWord = targets.length === 1 ? 'item' : 'items'
    const clipWord = referencingClipIds.length === 1 ? 'clip' : 'clips'
    const confirmed = await confirm({
      title: targets.length === 1 ? `Remove "${targets[0].fileName}"?` : `Remove ${targets.length} media ${itemWord}?`,
      message:
        referencingClipIds.length > 0
          ? `Used in ${referencingClipIds.length} ${clipWord} on the Timeline, which will be removed too. Files on disk are not deleted.`
          : 'Files on disk are not deleted -- only their entries in this project.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (!confirmed) return
    if (referencingClipIds.length > 0) {
      beginTransaction()
      selectClips(referencingClipIds)
      deleteSelected()
      endTransaction()
    }
    for (const target of targets) removeMedia(target.id)
  }, [items, selectedIds, sequence.clips, beginTransaction, endTransaction, selectClips, deleteSelected, removeMedia, confirm])

  const visibleIds = filteredItems.map((item) => item.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))

  return (
    <div
      className={`import-panel${isDragOver ? ' import-panel-drag-over' : ''}`}
      onDragOver={(e) => {
        if (ffmpegUnavailable) return
        e.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
    >
      <div className="panel-fixed-head">
        {ffmpegUnavailable && (
          <div className="ffmpeg-warning">FFmpeg unavailable: {ffmpegStatus?.error ?? 'unknown error'}. Import is disabled.</div>
        )}

        {/* "Media" and the search/filter/view-toggle share one row rather
            than the title sitting on its own line above or below them --
            the title always shows (even with nothing imported yet); the
            search controls only once there's something to search. */}
        <div className="media-search-row">
          <h2 className="media-search-row-title">Media</h2>
          {items.length > 0 && (
            <>
              <input
                className="media-search-input"
                placeholder="Search media…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                className="media-icon-button"
                title={sortBy === 'recent' ? 'Sorted by most recently added — click to sort by name' : 'Sorted by name — click to sort by recently added'}
                onClick={() => setSortBy((prev) => (prev === 'recent' ? 'name' : 'recent'))}
              >
                <FilterIcon />
              </button>
              <div className="media-view-toggle">
                <button
                  className={viewMode === 'grid' ? 'media-icon-button media-icon-button-active' : 'media-icon-button'}
                  title="Grid view"
                  onClick={() => setViewMode('grid')}
                >
                  <GridViewIcon />
                </button>
                <button
                  className={viewMode === 'list' ? 'media-icon-button media-icon-button-active' : 'media-icon-button'}
                  title="List view"
                  onClick={() => setViewMode('list')}
                >
                  <ListViewIcon />
                </button>
              </div>
            </>
          )}
        </div>

        {items.length > 0 && (
          <div className="media-kind-tabs">
            <button
              className={kindFilter === 'all' ? 'media-kind-tab media-kind-tab-active' : 'media-kind-tab'}
              onClick={() => setKindFilter('all')}
            >
              All
            </button>
            <button
              className={kindFilter === 'video' ? 'media-kind-tab media-kind-tab-active' : 'media-kind-tab'}
              onClick={() => setKindFilter('video')}
            >
              Video
            </button>
            <button
              className={kindFilter === 'audio' ? 'media-kind-tab media-kind-tab-active' : 'media-kind-tab'}
              onClick={() => setKindFilter('audio')}
            >
              Audio
            </button>

            {/* Selection tools on the same row, right-aligned: Select all
                (of what's visible under the current search/kind filter),
                then -- once anything is selected -- the count, Clear and
                Delete, so a batch of stray imports goes in two clicks. */}
            <div className="media-select-actions">
              {selectedIds.length > 0 && <span className="media-select-count">{selectedIds.length} selected</span>}
              {allVisibleSelected ? (
                <button className="media-kind-tab" onClick={clearMediaSelection} title="Clear selection">
                  Clear
                </button>
              ) : (
                <button className="media-kind-tab" disabled={visibleIds.length === 0} onClick={() => selectAllMedia(visibleIds)} title="Select all visible">
                  Select all
                </button>
              )}
              {selectedIds.length > 0 && (
                <button className="media-icon-button media-icon-button-danger" title={`Delete ${selectedIds.length} selected`} onClick={() => void handleRemoveSelected()}>
                  <TrashIcon size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <ul className={`media-grid panel-scroll-body editor-scroll${viewMode === 'list' ? ' media-grid-list' : ''}`}>
        {filteredItems.map((item) => (
          <MediaListItem
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            multiSelected={selectedIds.includes(item.id)}
            compact={viewMode === 'list'}
            onSelect={(e) => {
              const modifiers = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }
              if (modifiers.ctrl || modifiers.shift) {
                selectMedia(item.id, modifiers)
              } else {
                select(item.id)
                selectMedia(item.id, {})
              }
            }}
            onCancel={() => cancel(item.id)}
            onRetry={() => retry(item.id)}
            onDelete={() => void handleRemoveMedia(item)}
            onAddToTimeline={item.readyToUse ? () => handleAddToTimeline(item) : undefined}
            onDragStart={
              item.readyToUse
                ? (e) => {
                    const ids = selectedIds.includes(item.id) && selectedIds.length > 1 ? selectedIds : [item.id]
                    const payload: MediaDragPayload = { mediaIds: ids }
                    e.dataTransfer.setData(MEDIA_DRAG_MIME_TYPE, JSON.stringify(payload))
                    e.dataTransfer.effectAllowed = 'copy'
                    setCurrentDragMediaIds(ids)
                    // dragover can't read dataTransfer's actual payload (see
                    // mediaDragPayload.ts) -- dragend is the reliable place
                    // to clear the in-memory side-channel regardless of
                    // where/whether the drop landed.
                    e.currentTarget.addEventListener('dragend', () => setCurrentDragMediaIds(null), { once: true })
                  }
                : undefined
            }
          />
        ))}
        {items.length > 0 && filteredItems.length === 0 && <li className="placeholder">No media matches your search.</li>}
      </ul>
    </div>
  )
}
