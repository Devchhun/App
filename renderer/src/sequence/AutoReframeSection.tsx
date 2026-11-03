import type { TimelineClip } from '@shared/project'
import { EXPORT_ASPECT_RATIO_PARTS } from '@shared/export'
import { useMedia } from '../media/MediaContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useSequence } from './SequenceContext'
import { isReframed, removeReframe, runAutoReframe, stopAutoReframe, useAutoReframe } from './autoReframe'

/** Clip Properties > Auto Reframe: a wide video filling a tall frame (a
 * TikTok 9:16 from a 16:9 drama), or the other way round, with the frame
 * following the people in it -- the same job as the Toolbar's Reframe
 * button (autoReframe.ts), shown and stopped from either. */
export function AutoReframeSection({ clip, trackClipIds }: { clip: TimelineClip; trackClipIds: string[] }): JSX.Element {
  const { items } = useMedia()
  const { sequence, updateEachClipProperties } = useSequence()
  const { brandPreset } = useBrandPreset()
  const { busy, note } = useAutoReframe()

  const [aw, ah] = EXPORT_ASPECT_RATIO_PARTS[brandPreset.defaultAspectRatio]
  const run = (ids: string[]): void =>
    void runAutoReframe(ids, {
      clips: sequence.clips,
      pathOf: (id) => items.find((m) => m.id === id)?.originalPath,
      frameAspect: aw / ah,
      aspectLabel: brandPreset.defaultAspectRatio,
      apply: updateEachClipProperties
    })

  const locked = clip.locked
  return (
    <div className="cp-reframe">
      <p className="cp-speed-note">
        Fills the {brandPreset.defaultAspectRatio} frame with the video and moves it to keep the people in view -- for a wide video in a TikTok frame. Played and exported alike. Also on the Toolbar: Reframe.
      </p>
      {busy ? (
        <div className="cp-reframe-busy">
          <span>
            Looking for people{busy.files > 1 ? ` · video ${busy.file} of ${busy.files}` : ''} · {busy.percent}%
          </span>
          <button type="button" className="cp-fx-apply" onClick={stopAutoReframe}>
            Stop
          </button>
        </div>
      ) : (
        <div className="cp-reframe-actions">
          <button type="button" className="cp-fx-apply" disabled={locked} onClick={() => run([clip.id])}>
            {isReframed(clip) ? 'Reframe again' : 'Auto Reframe'}
          </button>
          <button type="button" className="cp-fx-apply cp-fx-apply-all" disabled={locked || trackClipIds.length < 2} onClick={() => run(trackClipIds)} title={`Every video clip on this track (${trackClipIds.length})`}>
            All on this track ({trackClipIds.length})
          </button>
          {isReframed(clip) && (
            <button type="button" className="cp-fx-apply" disabled={locked} onClick={() => removeReframe(trackClipIds.includes(clip.id) ? trackClipIds : [clip.id], sequence.clips, updateEachClipProperties)} title="Take the reframe off every clip on this track">
              Remove reframe
            </button>
          )}
        </div>
      )}
      {note && <div className="cp-speed-note">{note}</div>}
    </div>
  )
}
