import { useEffect, useState } from 'react'
import { useAiDubber } from './AiDubberContext'
import { useSequence } from '../sequence/SequenceContext'
import { useMedia } from '../media/MediaContext'
import { getMainVideoTrackId } from '../timeline/trackModel'
import { sourceTimeAt } from '@shared/clipTiming'
import { clampRegion, createDefaultVideoOverlaySettings, type SubtitleOverlayStyle } from '@shared/videoOverlay'

/** Subtitle & Blur: how the dubbed subtitles are drawn on the video, and
 * blur boxes over the original (burned-in) subtitles. Everything shows live
 * in the Player and is burned in by Export. While this is open the Player
 * lets the boxes be dragged and resized on the picture. */
export function SubtitleOverlayPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { videoOverlay, setVideoOverlay, setOverlayEditing, overlayLines } = useAiDubber()
  const { sequence } = useSequence()
  const { items } = useMedia()
  const { subtitles, blur } = videoOverlay
  const [detecting, setDetecting] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)

  /** Finds the video's own subtitles and puts the blur box on them: the
   * frames looked at are the ones under the subtitle lines (the original
   * subtitles are on screen then), in the video those lines belong to. */
  const autoDetect = async (): Promise<void> => {
    const mainTrackId = getMainVideoTrackId(sequence.tracks)
    const pictures = sequence.clips.filter((c) => c.type === 'video' && c.trackId === mainTrackId)
    if (pictures.length === 0) return setDetectNote('No video on the Timeline.')
    const byClip = new Map<string, number[]>()
    for (const line of overlayLines) {
      const mid = (line.start + line.end) / 2
      const clip = pictures.find((c) => c.startTime <= mid && mid < c.startTime + c.duration)
      if (clip) byClip.set(clip.id, [...(byClip.get(clip.id) ?? []), sourceTimeAt(clip, mid)])
    }
    const [clipId, middles] = [...byClip.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [[...pictures].sort((a, b) => b.duration - a.duration)[0].id, []]
    const clip = pictures.find((c) => c.id === clipId)
    const path = items.find((m) => m.id === clip?.mediaId)?.originalPath
    if (!path) return setDetectNote('The video file is not available.')
    setDetecting(true)
    setDetectNote(null)
    try {
      const band = await window.api.dubbing.detectBurnedSubtitles(path, middles)
      if (!band) {
        setDetectNote('No burned-in subtitles found -- place the box by hand.')
        return
      }
      setVideoOverlay((c) => ({ ...c, blur: { ...c.blur, enabled: true, regions: [clampRegion({ id: `blur-auto-${Date.now()}`, x: band.x, y: band.y, w: band.w, h: band.h })] } }))
      setDetectNote('Box placed on the original subtitles -- adjust it in the Player if needed.')
    } finally {
      setDetecting(false)
    }
  }

  useEffect(() => {
    setOverlayEditing(true)
    return () => setOverlayEditing(false)
  }, [setOverlayEditing])

  const setSub = (patch: Partial<SubtitleOverlayStyle>): void => setVideoOverlay((c) => ({ ...c, subtitles: { ...c.subtitles, ...patch } }))
  const setBlur = (patch: Partial<typeof blur>): void => setVideoOverlay((c) => ({ ...c, blur: { ...c.blur, ...patch } }))
  const addBox = (): void =>
    setVideoOverlay((c) => {
      const last = c.blur.regions[c.blur.regions.length - 1]
      const box = last ? { ...last, y: Math.max(0, last.y - last.h - 0.02) } : createDefaultVideoOverlaySettings().blur.regions[0]
      return { ...c, blur: { ...c.blur, enabled: true, regions: [...c.blur.regions, { ...box, id: `blur-${Date.now()}` }] } }
    })

  return (
    <div className="subtitle-overlay-panel" role="dialog" aria-label="Subtitle and blur on the video">
      <div className="subtitle-overlay-panel-header">
        <span>Subtitle &amp; Blur on video</span>
        <button className="subtitle-overlay-panel-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <section className={`subtitle-overlay-card${subtitles.enabled ? ' subtitle-overlay-card-on' : ''}`}>
        <Switch label="Subtitles" hint="The dubbed lines, drawn on the picture" checked={subtitles.enabled} onChange={(on) => setSub({ enabled: on })} />
        {subtitles.enabled && (
          <div className="subtitle-overlay-card-body">
            <Range label="Size" value={subtitles.fontSizePct} min={2} max={12} step={0.25} unit="%" onChange={(v) => setSub({ fontSizePct: v })} />
            <Range label="From bottom" value={subtitles.bottomPct} min={0} max={90} step={0.5} unit="%" onChange={(v) => setSub({ bottomPct: v })} />
            <Range label="Across" value={subtitles.xPct} min={10} max={90} step={0.5} unit="%" onChange={(v) => setSub({ xPct: v })} />
            <div className="subtitle-overlay-row subtitle-overlay-colors">
              <span className="subtitle-overlay-label">Colors</span>
              <label className="subtitle-overlay-swatch" title="Text color">
                <input type="color" value={subtitles.color} onChange={(e) => setSub({ color: e.target.value })} />
                Text
              </label>
              {subtitles.background ? (
                <label className="subtitle-overlay-swatch" title="Box color">
                  <input type="color" value={subtitles.backgroundColor} onChange={(e) => setSub({ backgroundColor: e.target.value })} />
                  Box
                </label>
              ) : (
                <label className="subtitle-overlay-swatch" title="Outline color">
                  <input type="color" value={subtitles.outlineColor} onChange={(e) => setSub({ outlineColor: e.target.value })} />
                  Outline
                </label>
              )}
              <button
                className={`subtitle-overlay-chip${subtitles.background ? ' subtitle-overlay-chip-on' : ''}`}
                title="A box behind the text instead of an outline"
                onClick={() => setSub({ background: !subtitles.background })}
              >
                ▭ Box
              </button>
            </div>
            {subtitles.background ? (
              <Range label="Box opacity" value={Math.round(subtitles.backgroundOpacity * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => setSub({ backgroundOpacity: v / 100 })} />
            ) : (
              <Range label="Outline" value={subtitles.outlinePct} min={0} max={1.2} step={0.05} unit="%" onChange={(v) => setSub({ outlinePct: v })} />
            )}
            <div className="subtitle-overlay-hint">Tip: drag a line in the Player to place it.</div>
          </div>
        )}
      </section>

      <section className={`subtitle-overlay-card${blur.enabled ? ' subtitle-overlay-card-on' : ''}`}>
        <Switch label="Blur original subtitles" hint="Hide the video's own (burned-in) text" checked={blur.enabled} onChange={(on) => setBlur({ enabled: on })} />
        <div className="subtitle-overlay-card-body">
          <button
            className="subtitle-overlay-button subtitle-overlay-button-primary subtitle-overlay-detect"
            disabled={detecting}
            title="Find where the video's own subtitles are and put the blur box on them"
            onClick={() => void autoDetect()}
          >
            {detecting ? 'Looking…' : '🔍 Auto-detect subtitles'}
          </button>
          {detectNote && <div className="subtitle-overlay-hint">{detectNote}</div>}
          {blur.enabled && (
            <>
              <Range label="Strength" value={blur.strength} min={2} max={40} step={1} onChange={(v) => setBlur({ strength: v })} />
              <div className="subtitle-overlay-row">
                <span className="subtitle-overlay-label">
                  {blur.regions.length} box{blur.regions.length === 1 ? '' : 'es'}
                </span>
                <button className="subtitle-overlay-button" onClick={addBox}>
                  + Add box
                </button>
                <button
                  className="subtitle-overlay-button"
                  title="One box across the lower part of the picture, where drama subtitles usually are"
                  onClick={() => setBlur({ enabled: true, regions: createDefaultVideoOverlaySettings().blur.regions })}
                >
                  Reset
                </button>
              </div>
              <div className="subtitle-overlay-hint">Tip: drag a box in the Player · drag a corner to resize.</div>
            </>
          )}
        </div>
      </section>
      <div className="subtitle-overlay-footnote">Shown live in the Player · burned into the video on Export.</div>
    </div>
  )
}

/** A card's on/off: its name and a one-line hint, a switch on the right. */
function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }): JSX.Element {
  return (
    <label className="subtitle-overlay-switch-row">
      <span className="subtitle-overlay-switch-text">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input type="checkbox" className="subtitle-overlay-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function Range({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="subtitle-overlay-row">
      <span className="subtitle-overlay-label">{label}</span>
      <input className="subtitle-overlay-range" type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="subtitle-overlay-value">
        {Number.isInteger(step) ? value : value.toFixed(2).replace(/0$/, '')}
        {unit ?? ''}
      </span>
    </div>
  )
}
