import { useCallback, useMemo, useState, type DragEvent } from 'react'
import { useMedia } from './MediaContext'
import { MediaListItem } from './MediaListItem'
import { FilterIcon, GridViewIcon, ListViewIcon } from '../nav/icons'
import { useSequence } from '../sequence/SequenceContext'
import { usePlayback } from '../playback/PlaybackContext'
import { assetFromMediaItem } from './assetFromMediaItem'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { DEFAULT_IMAGE_DURATION_SECONDS } from '../sequence/sequenceOps'
import type { MediaItem, MediaKind } from '@shared/media'
import { MEDIA_DRAG_MIME_TYPE, setCurrentDragMediaIds, type MediaDragPayload } from './mediaDragPayload'

type KindFilter = 'all' | MediaKind
type SortBy = 'recent' | 'name'
type ViewMode = 'grid' | 'list'

export function ImportPanel(): JSX.Element {
  const { items, importPaths, ffmpegStatus, selectedId, select, selectedIds, selectMedia, cancel, retry } = useMedia()
  const { sequence, insertClip, ensureTrack } = useSequence()
  const { currentTime } = usePlayback()
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

  // "Add to Timeline" (double-click / button) now auto-routes around
  // overlapping content the same way the Timeline's own drag-and-drop
  // already does (findOrCreateTrack) -- previously this always inserted
  // onto the fixed V1/A1 track regardless of what was already there,
  // silently landing two overlapping clips on the SAME track instead of
  // routing the second one to a free/new track.
  //
  // Placement time is appended after the LATEST clip on the timeline (across
  // every track), not the playhead -- clicking "+" repeatedly on several
  // media items in a row (without moving the playhead in between, which
  // nothing about this button prompts a user to do) previously landed every
  // one of them at the same `currentTime` on separate tracks, stacking them
  // all on top of each other instead of chaining one after another the way
  // Timeline.tsx's own drag-and-drop default (planSequentialDrop) already
  // does. An empty timeline still starts at the playhead (usually 0).
  const handleAddToTimeline = useCallback(
    (item: MediaItem) => {
      const isAudio = item.assetType === 'audio' || (item.kind === 'audio' && item.assetType !== 'video')
      const kind = isAudio ? 'audio' : 'video'
      const duration = item.assetType === 'image' ? DEFAULT_IMAGE_DURATION_SECONDS : (item.metadata?.durationSeconds ?? DEFAULT_IMAGE_DURATION_SECONDS)
      const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
      const appendAt = sequence.clips.length > 0 ? Math.max(...sequence.clips.map((c) => c.startTime + c.duration)) : currentTime
      const routing = findOrCreateTrack(sequence.tracks, occupied, appendAt, duration, kind)
      if (routing.newTrack) ensureTrack(routing.newTrack)
      insertClip(assetFromMediaItem(item), appendAt, routing.trackId)
    },
    [insertClip, currentTime, sequence.clips, sequence.tracks, ensureTrack]
  )

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

        {items.length > 0 ? (
          <>
            <div className="media-search-row">
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
            </div>
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
            </div>
          </>
        ) : null}
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
            onAddToTimeline={item.stage === 'ready' ? () => handleAddToTimeline(item) : undefined}
            onDragStart={
              item.stage === 'ready'
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
