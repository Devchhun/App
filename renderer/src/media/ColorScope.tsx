import { useEffect, useRef, type RefObject } from 'react'

/** RGB waveform scope over the frame the player is showing -- the same
 * picture CapCut's "Color oscilloscope" draws: x follows the frame's
 * columns, y is the level (0 at the bottom, full scale at the top), and
 * each channel plots in its own colour so a colour cast reads as one
 * parade riding above the others. Sampled from a 128x72 downscale of
 * the video ten times a second: cheap enough to leave on while editing. */

const COLS = 128
const ROWS = 72
const LEVELS = 64
const INTERVAL_MS = 100

export function ColorScope({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const sample = document.createElement('canvas')
    sample.width = COLS
    sample.height = ROWS
    const sctx = sample.getContext('2d', { willReadFrequently: true })
    if (!ctx || !sctx) return
    canvas.width = COLS
    canvas.height = LEVELS
    const image = ctx.createImageData(COLS, LEVELS)
    const counts = new Uint16Array(COLS * LEVELS * 3)
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const draw = (): void => {
      if (disposed) return
      const video = videoRef.current
      if (video && video.videoWidth > 0 && video.readyState >= 2) {
        sctx.drawImage(video, 0, 0, COLS, ROWS)
        const px = sctx.getImageData(0, 0, COLS, ROWS).data
        counts.fill(0)
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            const i = (y * COLS + x) * 4
            for (let c = 0; c < 3; c++) {
              const level = LEVELS - 1 - (px[i + c] >> 2)
              counts[(level * COLS + x) * 3 + c]++
            }
          }
        }
        const out = image.data
        for (let p = 0; p < COLS * LEVELS; p++) {
          // Each hit brightens its channel; ~10 hits saturate, so a flat
          // colour field shows as one bright line and noise as a haze.
          const r = Math.min(255, counts[p * 3] * 26)
          const g = Math.min(255, counts[p * 3 + 1] * 26)
          const b = Math.min(255, counts[p * 3 + 2] * 26)
          out[p * 4] = r
          out[p * 4 + 1] = g
          out[p * 4 + 2] = b
          out[p * 4 + 3] = 255
        }
        ctx.putImageData(image, 0, 0)
      } else {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, COLS, LEVELS)
      }
      timer = setTimeout(draw, INTERVAL_MS)
    }
    draw()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [videoRef])

  return (
    <div className="preview-scope" title="Color oscilloscope -- RGB waveform of the current frame">
      <canvas ref={canvasRef} className="preview-scope-canvas" />
      <div className="preview-scope-grid" aria-hidden />
    </div>
  )
}
