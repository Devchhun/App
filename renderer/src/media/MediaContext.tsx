import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, useRef } from 'react'
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
  /** Selects every item, or only `ids` (e.g. the currently filtered ones) when given. */
  selectAllMedia: (ids?: string[]) => void
  /** Resolves with the files picked (empty when the dialog was closed). */
  importFromDialog: () => Promise<string[]>
  importPaths: (paths: string[]) => Promise<void>
  cancel: (id: string) => void
  retry: (id: string) => void
  /** Removes an imported item from the project's media list entirely (never
   * touches the real source file on disk -- this app never deletes user
   * files). Any Timeline clips still referencing it are the caller's
   * responsibility to handle first (see ImportPanel.tsx's confirm-before-
   * delete flow) -- this alone doesn't know about `sequence.clips`. */
  removeMedia: (id: string) => void
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
    addedAt: new Date().toISOString(),
    readyToUse: false
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
        const { dropProxy, ...fields } = update
        const merged = { ...(existing ?? blankMediaItem(update.mediaId)), ...fields } as MediaItem
        // A damaged proxy (see app/main/media/proxy.ts): everything that
        // prefers the proxy falls back to the original until a new one is
        // made.
        if (dropProxy) {
          delete merged.proxyUrl
          delete merged.proxyPath
        }
        return { ...prev, [update.mediaId]: merged }
      })
      setOrder((prev) => (prev.includes(update.mediaId) ? prev : [...prev, update.mediaId]))
      setSelectedId((prev) => prev ?? update.mediaId)
    })
    return unsubscribe
  }, [])

  // Self-repair: an audio-bearing item that is done processing but has no
  // waveform (its background job failed, or it was saved before one was
  // made) gets one generated now -- asked once per item, so a file that
  // truly can't be decoded doesn't loop.
  const waveformAskedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const item of Object.values(items)) {
      if (item.waveform || !item.metadata?.hasAudio || !item.readyToUse || !item.originalPath) continue
      if (item.stage !== 'ready' && item.stage !== 'error') continue
      if (waveformAskedRef.current.has(item.id)) continue
      waveformAskedRef.current.add(item.id)
      void window.api.media.ensureWaveform(item.id, item.originalPath).then((waveform) => {
        if (!waveform) return
        setItems((prev) => (prev[item.id] ? { ...prev, [item.id]: { ...prev[item.id], waveform } } : prev))
      })
    }
  }, [items])

  const importPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    await window.api.media.importPaths(paths)
  }, [])

  const importFromDialog = useCallback(async (): Promise<string[]> => {
    const paths = await window.api.media.pickFiles()
    await importPaths(paths)
    return paths
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

  const selectAllMediaCb = useCallback(
    (ids?: string[]) => {
      setSelectedIds(selectAllMedia(ids ? orderedIds.filter((id) => ids.includes(id)) : orderedIds))
    },
    [orderedIds]
  )

  const removeMedia = useCallback((id: string) => {
    setItems((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _removed, ...rest } = prev
      return rest
    })
    setOrder((prev) => prev.filter((existingId) => existingId !== id))
    setSelectedId((prev) => (prev === id ? null : prev))
    setSelectedIds((prev) => prev.filter((existingId) => existingId !== id))
  }, [])

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
      removeMedia,
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
      removeMedia,
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
