import { useEffect, useRef } from 'react'
import type { WaveformData } from '@shared/media'
import { computeWaveformBars } from './waveformResample'

interface Props {
  waveform?: WaveformData
  /** The FULL underlying media file's duration -- `waveform.bucketCount`
   * buckets are spread evenly across this whole span (see
   * app/main/media/waveform.ts), not just this clip's own trimmed window. */
  sourceDurationSeconds: number
  /** Where in the source this clip's trimmed window starts. */
  sourceIn: number
  /** This clip's own on-Timeline duration (its trimmed window length). */
  duration: number
  widthPx: number
  heightPx: number
}

/** Renders one clip's own waveform, resampled to its CURRENT on-screen pixel
 * width every time it changes -- one bar per screen pixel, each covering
 * exactly the slice of source-time that pixel represents. Zooming in shrinks
 * the source-time-per-pixel, so more of the underlying 1200 cached buckets
 * get sampled into more, finer bars (real added detail) instead of the same
 * fixed bar count simply stretching wider. A trimmed clip only ever draws
 * the [sourceIn, sourceIn+duration) slice of the full-file waveform, matching
 * how VideoFilmstrip.tsx already scopes its own thumbnails to a clip's
 * trimmed window via `startOffset`. */
export function WaveformTrack({ waveform, sourceDurationSeconds, sourceIn, duration, widthPx, heightPx }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(widthPx))
    const h = Math.max(1, Math.round(heightPx))
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const bars = computeWaveformBars(waveform, sourceDurationSeconds, sourceIn, duration, w)
    if (bars.length === 0) return

    const mid = h / 2
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    bars.forEach((bar, x) => {
      const yTop = mid - bar.max * mid
      const yBottom = mid - bar.min * mid
      ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop))
    })
  }, [waveform, sourceDurationSeconds, sourceIn, duration, widthPx, heightPx])

  return <canvas ref={canvasRef} className="clip-track-clip-waveform" style={{ width: widthPx, height: heightPx }} />
}
