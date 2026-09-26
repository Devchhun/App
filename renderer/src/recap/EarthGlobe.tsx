import { useEffect, useRef } from 'react'
// Inlined as a data URL: a canvas that draws a file:// image is "tainted"
// in the packaged app and getImageData would throw.
import earthTextureUrl from '../assets/earth-blue-marble.jpg?inline'
import { buildGlobeSamples, paintGlobe } from './globeMath'

/** NASA Blue Marble (public domain), 1024x512 equirectangular, slightly
 * brightened and saturated so it reads at button size. */
let texturePromise: Promise<ImageData | null> | null = null
function loadTexture(): Promise<ImageData | null> {
  texturePromise ??= new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(image, 0, 0)
      resolve(ctx.getImageData(0, 0, image.width, image.height))
    }
    image.onerror = () => resolve(null)
    image.src = earthTextureUrl
  })
  return texturePromise
}

const FRAME_MS = 1000 / 30

/** A real-looking Earth turning on its tilted axis, drawn as a sphere
 * (not a sliding flat picture): sunlit side, dim night side, blue haze at
 * the rim. Still when the OS asks for reduced motion. */
export function EarthGlobe({ size = 40, secondsPerTurn = 24, className }: { size?: number; secondsPerTurn?: number; className?: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    // At least 2x the screen pixels, scaled down by the browser: a smooth
    // edge and sharp coastlines instead of a 1:1 jagged disc.
    const pixels = Math.round(size * Math.max(2, Math.min(3, (window.devicePixelRatio || 1) * 2)))
    canvas.width = pixels
    canvas.height = pixels
    const samples = buildGlobeSamples(pixels)
    const frame = ctx.createImageData(pixels, pixels)
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let alive = true
    let raf = 0
    let last = -Infinity
    void loadTexture().then((texture) => {
      if (!alive || !texture) return
      const draw = (now: number): void => {
        if (!alive) return
        if (now - last >= FRAME_MS) {
          last = now
          // Start with Asia in view, then turn.
          const turn = 0.3 + (still ? 0 : now / 1000 / secondsPerTurn)
          paintGlobe(samples, texture, turn, frame.data)
          ctx.putImageData(frame, 0, 0)
        }
        if (!still) raf = requestAnimationFrame(draw)
      }
      raf = requestAnimationFrame(draw)
    })
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [size, secondsPerTurn])

  return <canvas ref={canvasRef} className={className ? `earth-globe ${className}` : 'earth-globe'} style={{ width: size, height: size }} aria-hidden />
}
