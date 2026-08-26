import { useEffect, useRef, useState } from 'react'

interface Props {
  src: string | undefined
  duration: number
  widthPx: number
  /** Source-seconds to start sampling from -- lets a trimmed clip's filmstrip
   * represent its own `[sourceIn, sourceOut]` window instead of always
   * starting from the underlying file's beginning. */
  startOffset?: number
}

const FRAME_TARGET_WIDTH_PX = 100
const MAX_FRAMES = 40
const CAPTURE_WIDTH = 160
const CAPTURE_HEIGHT = 90
const REGEN_DEBOUNCE_MS = 250

/** Real per-frame filmstrip for the V1 video track, extracted via an
 * offscreen <video> + <canvas> (seek -> draw -> toDataURL) rather than
 * tiling one static thumbnail -- a single repeated frame reads as broken
 * next to a real editor's timeline. Frames render progressively as they're
 * captured, and regeneration is debounced so scrubbing the zoom slider
 * doesn't trigger a burst of re-extraction.
 *
 * Viewport-gated: extraction only runs while this clip's filmstrip is
 * actually (near) visible in the Timeline's own scroll container. Every
 * mounted filmstrip previously spun up its own offscreen <video> element
 * (a real WebMediaPlayer instance) regardless of scroll position -- a
 * project with hundreds of simultaneously-mounted video clips could exceed
 * Chromium's hard per-page WebMediaPlayer limit, silently failing to render
 * filmstrips (and logging console errors) past that point. This only
 * changes *when* frame extraction runs; the frames themselves, clip
 * timing/thumbnails/selection/zoom, and every other Timeline behavior are
 * untouched. */
export function VideoFilmstrip({ src, duration, widthPx, startOffset = 0 }: Props): JSX.Element {
  const [frames, setFrames] = useState<string[]>([])
  const [isVisible, setIsVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), {
      root: el.closest('.timeline-scroll-2d'),
      // Small buffer so a filmstrip starts loading just before it scrolls
      // into view rather than popping in -- large enough to feel smooth,
      // nowhere near large enough to defeat the whole point of gating.
      rootMargin: '200px 400px',
      threshold: 0
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isVisible || !src || duration <= 0 || widthPx <= 0) {
      setFrames([])
      return
    }

    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current
      const frameCount = Math.max(4, Math.min(MAX_FRAMES, Math.round(widthPx / FRAME_TARGET_WIDTH_PX)))
      const video = document.createElement('video')
      video.src = src
      video.muted = true
      video.preload = 'auto'
      const canvas = document.createElement('canvas')
      canvas.width = CAPTURE_WIDTH
      canvas.height = CAPTURE_HEIGHT
      const ctx = canvas.getContext('2d')

      const captureAt = (time: number): Promise<string | null> =>
        new Promise((resolve) => {
          const onSeeked = (): void => {
            video.removeEventListener('seeked', onSeeked)
            if (!ctx) return resolve(null)
            try {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
              resolve(canvas.toDataURL('image/jpeg', 0.6))
            } catch {
              resolve(null)
            }
          }
          video.addEventListener('seeked', onSeeked)
          video.currentTime = time
        })

      const run = async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          if (video.readyState >= 1) resolve()
          else video.addEventListener('loadedmetadata', () => resolve(), { once: true })
        })
        const results: string[] = []
        for (let i = 0; i < frameCount; i++) {
          if (requestIdRef.current !== requestId) return
          const t = startOffset + Math.min(Math.max(0, duration - 0.05), (duration * (i + 0.5)) / frameCount)
          const frame = await captureAt(t)
          if (requestIdRef.current !== requestId) return
          if (frame) {
            results.push(frame)
            setFrames([...results])
          }
        }
      }

      void run()
    }, REGEN_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      requestIdRef.current++
    }
  }, [isVisible, src, duration, widthPx, startOffset])

  return (
    <div className="video-filmstrip" ref={containerRef}>
      {frames.map((frame, i) => (
        <img key={i} src={frame} alt="" className="video-filmstrip-frame" draggable={false} />
      ))}
    </div>
  )
}
