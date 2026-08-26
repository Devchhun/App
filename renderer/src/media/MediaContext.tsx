import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FfmpegAvailability, MediaItem } from '@shared/media'
import { updateMediaSelection, clearMediaSelection, selectAllMedia, type ClickModifiers } from './mediaSelection'

interface MediaContextValue {
  items: MediaItem[]
  selectedId: string | null
  select: (id: string) => void
  /** Multi-select for dragging several assets onto the Timeline together
   * (see Timeline.tsx's drag-drop handler) -- kept entirely independent of
   * `selectedId` (the single asset open for inspection/Preview source),
   * matching this app's established selection-independence invariant. */
  selectedIds: string[]
  selectMedia: (id: string, modifiers?: ClickModifiers) => void
  clearMediaSelection: () => void
  selectAllMedia: () => void
  importFromDialog: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  cancel: (id: string) => void
  retry: (id: string) => void
  ffmpegStatus: FfmpegAvailability | null
  /** Bulk-replaces the whole media list -- used once, on project load, to
   * reconstruct already-ready MediaItems from the saved project's
   * MediaSource[] (see window.api.media.rehydrate) without re-running the
   * import pipeline. Never touches `selectedId`. */
  hydrateFromSaved: (items: MediaItem[]) => void
}

const MediaContext = createContext<MediaContextValue | null>(null)

function blankMediaItem(id: string): MediaItem {
  return {
    id,
    kind: 'video',
    fileName: '',
    originalPath: '',
    originalUrl: '',
    stage: 'queued',
    percent: 0,
    cached: false,
    addedAt: new Date().toISOString()
  }
}

export function MediaProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<Record<string, MediaItem>>({})
  const [order, setOrder] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegAvailability | null>(null)

  useEffect(() => {
    window.api.media.getFfmpegStatus().then(setFfmpegStatus)
    const unsubscribe = window.api.media.onProgress((update) => {
      setItems((prev) => {
        const existing = prev[update.mediaId]
        const merged = { ...(existing ?? blankMediaItem(update.mediaId)), ...update } as MediaItem
        return { ...prev, [update.mediaId]: merged }
      })
      setOrder((prev) => (prev.includes(update.mediaId) ? prev : [...prev, update.mediaId]))
      setSelectedId((prev) => prev ?? update.mediaId)
    })
    return unsubscribe
  }, [])

  const importPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    await window.api.media.importPaths(paths)
  }, [])

  const importFromDialog = useCallback(async () => {
    const paths = await window.api.media.pickFiles()
    await importPaths(paths)
  }, [importPaths])

  const cancel = useCallback((id: string) => {
    void window.api.media.cancelJob(id)
  }, [])

  const retry = useCallback((id: string) => {
    void window.api.media.retryJob(id)
  }, [])

  const select = useCallback((id: string) => setSelectedId(id), [])

  const orderedIds = order

  const selectMedia = useCallback(
    (id: string, modifiers: ClickModifiers = {}) => {
      setSelectedIds((prev) => updateMediaSelection(prev, id, orderedIds, modifiers))
    },
    [orderedIds]
  )

  const clearMediaSelectionCb = useCallback(() => {
    setSelectedIds((prev) => clearMediaSelection(prev))
  }, [])

  const selectAllMediaCb = useCallback(() => {
    setSelectedIds(selectAllMedia(orderedIds))
  }, [orderedIds])

  const hydrateFromSaved = useCallback((saved: MediaItem[]) => {
    if (saved.length === 0) return
    setItems(Object.fromEntries(saved.map((item) => [item.id, item])))
    setOrder(saved.map((item) => item.id))
  }, [])

  const value = useMemo<MediaContextValue>(
    () => ({
      items: order.map((id) => items[id]).filter((item): item is MediaItem => Boolean(item)),
      selectedId,
      select,
      selectedIds,
      selectMedia,
      clearMediaSelection: clearMediaSelectionCb,
      selectAllMedia: selectAllMediaCb,
      importFromDialog,
      importPaths,
      cancel,
      retry,
      ffmpegStatus,
      hydrateFromSaved
    }),
    [
      order,
      items,
      selectedId,
      select,
      selectedIds,
      selectMedia,
      clearMediaSelectionCb,
      selectAllMediaCb,
      importFromDialog,
      importPaths,
      cancel,
      retry,
      ffmpegStatus,
      hydrateFromSaved
    ]
  )

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>
}

export function useMedia(): MediaContextValue {
  const ctx = useContext(MediaContext)
  if (!ctx) throw new Error('useMedia must be used within MediaProvider')
  return ctx
}
