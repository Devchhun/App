import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { sourceEnd } from '@shared/clipTiming'
import { audioEffectFilter, isNeutralAudioEffect, sanitizeAudioEffectSettings, type AudioEffectSettings } from '@shared/audioEffects'
import type { TimelineClip } from '@shared/project'
import type { MediaItem } from '@shared/media'

interface AudioEffectsValue {
  /** Renders `settings` into each audio clip (or puts the original back,
   * for neutral settings). One Undo step for the whole batch. */
  applyAudioEffect: (clipIds: string[], settings: AudioEffectSettings) => Promise<{ done: number; failed: number }>
  /** Progress of the running batch, or null. */
  progress: { done: number; total: number } | null
}

const AudioEffectsContext = createContext<AudioEffectsValue | null>(null)

/** How many clips render at once. */
const PARALLEL = 3
/** How long an imported render may take to become usable. */
const IMPORT_TIMEOUT_MS = 60_000

/** The original sound a clip's current window comes from: an effect clip
 * maps 1:1 onto its source (the render is that source window, start to
 * end), so a split or trimmed piece still finds its own part of it. */
export function originalWindowOf(clip: TimelineClip): { mediaId: string; sourceIn: number; sourceOut: number } {
  const fx = clip.audioEffect
  if (!fx) return { mediaId: clip.mediaId, sourceIn: clip.sourceIn, sourceOut: sourceEnd(clip) }
  return { mediaId: fx.source.mediaId, sourceIn: fx.source.sourceIn + clip.sourceIn, sourceOut: fx.source.sourceIn + sourceEnd(clip) }
}

export function AudioEffectsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { items, importPaths } = useMedia()
  const { sequence, setClipAudioSource } = useSequence()
  const { beginTransaction, endTransaction } = useHistory()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const sequenceRef = useRef(sequence)
  sequenceRef.current = sequence
  const itemsRef = useRef(items)
  itemsRef.current = items

  /** Renders waiting on their import round-trip, keyed by file path. */
  const waitersRef = useRef<Map<string, (item: MediaItem | null) => void>>(new Map())
  useEffect(() => {
    for (const [path, resolve] of waitersRef.current) {
      const item = items.find((m) => m.originalPath === path)
      if (!item) continue
      if (item.stage === 'error') {
        waitersRef.current.delete(path)
        resolve(null)
      } else if (item.readyToUse || item.stage === 'ready') {
        waitersRef.current.delete(path)
        resolve(item)
      }
    }
  }, [items])

  const importAndWait = useCallback(
    (path: string): Promise<MediaItem | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waitersRef.current.delete(path)
          resolve(null)
        }, IMPORT_TIMEOUT_MS)
        waitersRef.current.set(path, (item) => {
          clearTimeout(timer)
          resolve(item)
        })
        void importPaths([path])
      }),
    [importPaths]
  )

  const applyOne = useCallback(
    async (clipId: string, settings: AudioEffectSettings): Promise<boolean> => {
      const clip = sequenceRef.current.clips.find((c) => c.id === clipId)
      if (!clip || clip.type !== 'audio' || clip.locked) return false
      const original = originalWindowOf(clip)
      if (isNeutralAudioEffect(settings)) {
        if (clip.audioEffect) setClipAudioSource(clipId, { ...original, audioEffect: undefined })
        return true
      }
      const path = itemsRef.current.find((m) => m.id === original.mediaId)?.originalPath
      if (!path) return false
      const result = await window.api.dubbing.renderAudioEffect(`audiofx-${clipId}-${Date.now()}`, path, original.sourceIn, original.sourceOut, audioEffectFilter(settings))
      if (!result.ok) return false
      const item = await importAndWait(result.outputPath)
      if (!item) return false
      setClipAudioSource(clipId, {
        mediaId: item.id,
        sourceIn: 0,
        sourceOut: original.sourceOut - original.sourceIn,
        audioEffect: { settings, source: original }
      })
      return true
    },
    [importAndWait, setClipAudioSource]
  )

  const applyAudioEffect = useCallback(
    async (clipIds: string[], raw: AudioEffectSettings): Promise<{ done: number; failed: number }> => {
      const settings = sanitizeAudioEffectSettings(raw)
      const ids = [...new Set(clipIds)]
      let done = 0
      let failed = 0
      let next = 0
      setProgress({ done: 0, total: ids.length })
      beginTransaction()
      try {
        const lane = async (): Promise<void> => {
          while (next < ids.length) {
            const id = ids[next++]
            const ok = await applyOne(id, settings).catch(() => false)
            if (ok) done++
            else failed++
            setProgress({ done: done + failed, total: ids.length })
          }
        }
        await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, lane))
      } finally {
        endTransaction()
        setProgress(null)
      }
      return { done, failed }
    },
    [applyOne, beginTransaction, endTransaction]
  )

  const value = useMemo(() => ({ applyAudioEffect, progress }), [applyAudioEffect, progress])
  return <AudioEffectsContext.Provider value={value}>{children}</AudioEffectsContext.Provider>
}

export function useAudioEffects(): AudioEffectsValue {
  const ctx = useContext(AudioEffectsContext)
  if (!ctx) throw new Error('useAudioEffects must be used inside AudioEffectsProvider')
  return ctx
}
