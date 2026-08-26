import { useCallback, useEffect, useRef } from 'react'
import type { TimelineClip } from '@shared/project'
import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { useTimelineView } from './TimelineViewContext'
import { DEFAULT_IMAGE_DURATION_SECONDS } from '../sequence/sequenceOps'
import { assetFromMediaItem } from '../media/assetFromMediaItem'

/** Freeze Frame is available for a video clip that covers the current
 * playhead -- shared by the toolbar button and the clip context menu so
 * both agree on the exact same guard. */
export function canFreezeFrame(clip: TimelineClip | undefined, currentTime: number): boolean {
  return !!clip && clip.type === 'video' && currentTime >= clip.startTime && currentTime < clip.startTime + clip.duration
}

interface PendingFreezeFrame {
  path: string
  trackId: string
  linkedTrackId: string | undefined
  atTime: number
  clipId: string
}

/** Freeze Frame (spec section 13/checkpoint 4) -- captures the frame the
 * main <video> is currently showing, saves it to a real file via the same
 * media cache every import uses, then runs it through the EXISTING import
 * pipeline (window.api.media.importPaths) rather than a parallel ingest
 * path. Once the import comes back ready, the source clip (+ its linked
 * audio clip, if Linkage is on) is split at the playhead, a gap the size of
 * one default image duration is opened on both linked tracks, and the
 * frozen frame drops into it -- grouped as one Undo entry.
 *
 * Each call site (toolbar button, clip context menu) gets its OWN pending
 * ref/effect via its own call to this hook -- safe to call from more than
 * one component at once, since only the instance that actually triggered a
 * capture ever has a non-null pending ref for the `items` effect to act on. */
export function useFreezeFrame(): { triggerFreezeFrame: (clip: TimelineClip) => void } {
  const { items, importPaths } = useMedia()
  const { currentTime, captureFrame } = usePlayback()
  const { sequence, splitClipAt, insertGapAt, insertClip } = useSequence()
  const { beginTransaction, endTransaction } = useHistory()
  const { linkageOn } = useTimelineView()

  const pendingRef = useRef<PendingFreezeFrame | null>(null)

  useEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    const match = items.find((item) => item.originalPath === pending.path)
    if (!match || (match.stage !== 'ready' && match.stage !== 'error')) return
    pendingRef.current = null
    if (match.stage === 'error') return

    beginTransaction()
    splitClipAt(pending.clipId, pending.atTime, { linked: !!pending.linkedTrackId })
    insertGapAt(pending.trackId, pending.atTime, DEFAULT_IMAGE_DURATION_SECONDS)
    if (pending.linkedTrackId) insertGapAt(pending.linkedTrackId, pending.atTime, DEFAULT_IMAGE_DURATION_SECONDS)
    insertClip(assetFromMediaItem(match), pending.atTime, pending.trackId)
    endTransaction()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` should retrigger this; the context methods are stable callbacks.
  }, [items])

  const triggerFreezeFrame = useCallback(
    (clip: TimelineClip) => {
      if (!canFreezeFrame(clip, currentTime)) return
      const dataUrl = captureFrame()
      if (!dataUrl) return

      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const linkedClip = clip.linkedClipId ? sequence.clips.find((c) => c.id === clip.linkedClipId) : undefined
      const fileName = `freeze-frame-${Date.now()}.png`

      void window.api.media.saveGeneratedFile(fileName, bytes).then(async (savedPath) => {
        pendingRef.current = {
          path: savedPath,
          trackId: clip.trackId,
          linkedTrackId: linkageOn && linkedClip ? linkedClip.trackId : undefined,
          atTime: currentTime,
          clipId: clip.id
        }
        await importPaths([savedPath])
      })
    },
    [currentTime, captureFrame, sequence.clips, linkageOn, importPaths]
  )

  return { triggerFreezeFrame }
}
