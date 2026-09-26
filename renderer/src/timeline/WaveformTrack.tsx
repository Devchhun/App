import { useEffect, useRef, useState } from 'react'
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

const BAR_WIDTH = 2
const BAR_STEP = 3
const MIN_BAR_PX = 1
/** Slightly under linear: keeps the loud/quiet contrast CapCut's bars
 * have (a whisper is a short bar, not half height) while a quiet room
 * still shows a floor. */
const LOUDNESS_CURVE = 0.85
/** Bright sky blue on the clip's navy -- lighter through the middle where
 * every picket overlaps, a touch deeper at the tips. */
const WAVE_CORE = '#9fdcff'
const WAVE_EDGE = '#52b1ff'

/** Drawn on either side of the visible window, so ordinary scrolling
 * never shows an undrawn edge before the next redraw lands. */
const OVERDRAW_PX = 400
/** A canvas wider than this fails to allocate in Chromium and paints as
 * a solid white block -- a 30-minute clip at a normal zoom is 70,000 px
 * wide, so the waveform is drawn only for the part on screen. */
const MAX_CANVAS_PX = 8000

/** The file's loudest sample (0-1), never below a floor so silence doesn't
 * blow up into full-height noise. Cached per waveform: a half-hour file
 * has ~170k peaks and every clip of it redraws on scroll. */
const peakCache = new WeakMap<WaveformData, number>()
function filePeak(waveform: WaveformData | undefined): number {
  if (!waveform) return 1
  const cached = peakCache.get(waveform)
  if (cached !== undefined) return cached
  let peak = 0
  for (let i = 0; i < waveform.peaks.length; i++) peak = Math.max(peak, Math.abs(waveform.peaks[i]))
  const result = Math.max(0.05, peak)
  peakCache.set(waveform, result)
  return result
}

/** Renders one clip's own waveform for the slice of it that is on screen
 * (plus a margin), resampled to screen pixels -- one picket per 3 px,
 * each covering exactly the source-time those pixels represent. Zooming
 * in shrinks the source-time-per-pixel, so more of the underlying 1200
 * cached buckets get sampled into finer bars (real added detail) instead
 * of the same fixed bar count simply stretching wider. A trimmed clip only
 * ever draws the [sourceIn, sourceIn+duration) slice of the full-file
 * waveform. The canvas follows the Timeline's horizontal scroll: it is
 * repositioned and redrawn as the visible window moves, so a clip of any
 * length costs one screen's worth of canvas. */
export function WaveformTrack({ waveform, sourceDurationSeconds, sourceIn, duration, widthPx, heightPx }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The slice of the clip (in clip px) the canvas currently covers.
  const [slice, setSlice] = useState<{ start: number; width: number }>({ start: 0, width: Math.min(widthPx, MAX_CANVAS_PX) })

  // Track the horizontal scroll of the Timeline so the drawn slice follows
  // the viewport. A clip narrower than the cap is simply drawn whole.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const scroller = canvas.closest('.timeline-scroll-2d') as HTMLElement | null
    const w = Math.max(1, Math.round(widthPx))
    if (w <= MAX_CANVAS_PX || !scroller) {
      setSlice({ start: 0, width: Math.min(w, MAX_CANVAS_PX) })
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const update = (): void => {
      timer = null
      const clipEl = canvas.parentElement as HTMLElement | null
      if (!clipEl) return
      // Where the clip sits relative to the scroller's content, from the
      // DOM rather than from props (the clip may be mid-drag).
      const clipLeft = clipEl.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft
      const viewStart = scroller.scrollLeft - clipLeft - OVERDRAW_PX
      const viewEnd = scroller.scrollLeft + scroller.clientWidth - clipLeft + OVERDRAW_PX
      const start = Math.max(0, Math.floor(viewStart / BAR_STEP) * BAR_STEP)
      const end = Math.min(w, Math.ceil(viewEnd))
      const width = Math.max(1, Math.min(MAX_CANVAS_PX, end - start))
      setSlice((prev) => (prev.start === start && prev.width === width ? prev : { start, width }))
    }
    // Trailing debounce rather than per-frame: the 400 px overdraw covers
    // a scroll's first stretch, and a drag that auto-scrolls the Timeline
    // must not pay a canvas redraw on every frame it moves.
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(update, 80)
    }
    update()
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (timer !== null) clearTimeout(timer)
    }
  }, [widthPx])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(slice.width))
    const h = Math.max(1, Math.round(heightPx))
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    // The slice's own window into the source: shift `sourceIn` by the
    // slice offset and shrink the duration to what the slice spans.
    const pixelsPerSecond = widthPx / Math.max(1e-6, duration)
    const sliceSourceIn = sourceIn + slice.start / pixelsPerSecond
    const sliceDuration = w / pixelsPerSecond
    const bars = computeWaveformBars(waveform, sourceDurationSeconds, sliceSourceIn, sliceDuration, w)
    if (bars.length === 0) return

    // CapCut-style bars: 2 px wide with a 1 px gap, standing on the
    // clip's bottom edge (not mirrored about the middle), scaled to the
    // FILE's own loudest moment so a quiet recording still reaches the
    // top somewhere (and the scale never jumps as the clip is trimmed or
    // the view zoomed). Each bar's height is the loudness of the stretch
    // it covers (see WaveformBar.avg), so a zoomed-out clip shows its
    // dynamics rather than a solid wall of peaks.
    const peak = filePeak(waveform)
    const bottom = h - 2
    const usable = Math.max(2, h - 5)
    const gradient = ctx.createLinearGradient(0, bottom - usable, 0, bottom)
    gradient.addColorStop(0, WAVE_CORE)
    gradient.addColorStop(1, WAVE_EDGE)
    ctx.fillStyle = gradient
    for (let x = 0; x < w; x += BAR_STEP) {
      let amp = 0
      for (let i = x; i < Math.min(w, x + BAR_WIDTH); i++) amp = Math.max(amp, bars[i].avg)
      const height = Math.max(MIN_BAR_PX, Math.pow(amp / peak, LOUDNESS_CURVE) * usable)
      ctx.fillRect(x, bottom - height, BAR_WIDTH, height)
    }
  }, [waveform, sourceDurationSeconds, sourceIn, duration, widthPx, heightPx, slice])

  return <canvas ref={canvasRef} className="clip-track-clip-waveform" style={{ left: slice.start, width: slice.width, height: heightPx }} />
}
