import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogoTemplate } from '@shared/media'
import type { ClipTransform } from '@shared/project'
import { useMedia } from '../media/MediaContext'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { useSequence } from '../sequence/SequenceContext'
import { usePlaybackControls } from '../playback/PlaybackContext'
import { useHistory } from '../history/HistoryContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useConfirm } from '../ui/ConfirmDialog'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { logoCornerTransform } from './logoPlacement'
import { PlusIcon } from '../nav/icons'

/** How long a logo added at the playhead stays. */
const LOGO_SECONDS = 5
/** Templates > My Logos: the channel's logos, saved once and used in every
 * project. "Add" puts one at the playhead, "Whole video" over the whole
 * video like a watermark -- both as an image clip on a track of its own,
 * small in the top-right corner (then moved with the Player's frame). An
 * image clip, unlike a graphic template, goes into the exported video. */
export function MyLogosSection(): JSX.Element {
  const { items, importPaths } = useMedia()
  const { sequence, insertClip, ensureTrack, trimClip, updateClipProperties, selectClips } = useSequence()
  const { getCurrentTime } = usePlaybackControls()
  const { beginTransaction, endTransaction } = useHistory()
  const { brandPreset } = useBrandPreset()
  const confirm = useConfirm()
  const [logos, setLogos] = useState<LogoTemplate[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  /** A logo just inserted: sized, placed and lengthened once it is on the Timeline. */
  const pendingRef = useRef<{ mediaId: string; trackId: string; start: number; end: number; transform: Pick<ClipTransform, 'x' | 'y' | 'scaleX' | 'scaleY'> } | null>(null)

  const refresh = useCallback(async () => setLogos(await window.api.media.listLogoTemplates()), [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    const clip = sequence.clips.find((c) => c.mediaId === pending.mediaId && c.trackId === pending.trackId && Math.abs(c.startTime - pending.start) < 1e-3)
    if (!clip) return
    pendingRef.current = null
    if (Math.abs(clip.startTime + clip.duration - pending.end) > 1e-3) trimClip(clip.id, 'right', pending.end)
    updateClipProperties(clip.id, { transform: { rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, ...pending.transform } })
    selectClips([clip.id])
    requestAnimationFrame(() => endTransaction())
  }, [sequence.clips, trimClip, updateClipProperties, selectClips, endTransaction])

  const insert = async (logo: LogoTemplate, wholeVideo: boolean): Promise<void> => {
    setBusy(logo.id)
    try {
      let item = itemsRef.current.find((m) => m.originalPath === logo.path)
      if (!item) await importPaths([logo.path])
      for (let i = 0; i < 200 && !(item = itemsRef.current.find((m) => m.originalPath === logo.path))?.readyToUse; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!item?.readyToUse) return
      const videoEnd = sequence.clips.filter((c) => c.type === 'video').reduce((end, c) => Math.max(end, c.startTime + c.duration), 0)
      const start = wholeVideo ? 0 : getCurrentTime()
      const end = wholeVideo ? Math.max(videoEnd, LOGO_SECONDS) : start + LOGO_SECONDS
      const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
      const routing = findOrCreateTrack(sequence.tracks, occupied, start, end - start, 'video')
      const size = item.metadata?.width && item.metadata.height ? { width: item.metadata.width, height: item.metadata.height } : { width: 4, height: 1 }
      beginTransaction()
      if (routing.newTrack) ensureTrack(routing.newTrack)
      const pending = { mediaId: item.id, trackId: routing.trackId, start, end, transform: logoCornerTransform(size, brandPreset.defaultAspectRatio) }
      pendingRef.current = pending
      insertClip(assetFromMediaItem(item), start, routing.trackId)
      // Never left open: should the clip not appear, the Undo step still closes.
      setTimeout(() => {
        if (pendingRef.current === pending) {
          pendingRef.current = null
          endTransaction()
        }
      }, 3000)
    } finally {
      setBusy(null)
    }
  }

  const add = async (): Promise<void> => {
    const logo = await window.api.media.addLogoTemplate()
    if (logo) await refresh()
  }

  const remove = async (logo: LogoTemplate): Promise<void> => {
    const ok = await confirm({
      title: `Remove "${logo.name}" from My Logos?`,
      message: 'It is no longer offered here. Videos and projects that already use it keep it.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (!ok) return
    await window.api.media.removeLogoTemplate(logo.id)
    await refresh()
  }

  return (
    <section className="my-logos">
      <div className="my-logos-head">
        <span className="my-logos-title">My Logos</span>
        <button className="my-logos-add" title="Add a logo (a PNG with a transparent background) -- kept for every project" onClick={() => void add()}>
          <PlusIcon size={13} />
          Logo
        </button>
      </div>
      {logos.length === 0 ? (
        <p className="my-logos-empty">Add your channel logo once (a transparent PNG) — then put it on any video in one click.</p>
      ) : (
        <div className="my-logos-grid">
          {logos.map((logo) => (
            <div key={logo.id} className="my-logos-card" title={logo.name}>
              <div className="my-logos-thumb">
                <img src={logo.url} alt="" draggable={false} />
                <button className="my-logos-remove" title="Remove from My Logos" onClick={() => void remove(logo)}>
                  ×
                </button>
              </div>
              <span className="my-logos-name">{logo.name}</span>
              <div className="my-logos-actions">
                <button disabled={busy !== null} title={`Add at the playhead for ${LOGO_SECONDS} s (top-right corner)`} onClick={() => void insert(logo, false)}>
                  Add
                </button>
                <button disabled={busy !== null || !sequence.clips.some((c) => c.type === 'video')} title="Over the whole video, like a watermark (top-right corner)" onClick={() => void insert(logo, true)}>
                  Whole video
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
