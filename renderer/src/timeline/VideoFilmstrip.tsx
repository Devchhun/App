import { useEffect, useRef, useState } from 'react'
import { frameCountForWidth, filmstripCacheKey, readFilmstripCache, writeFilmstripCache } from './filmstripCache'

interface Props {
  src: string | undefined
  duration: number
  widthPx: number
  /** Source-seconds to start sampling from -- lets a trimmed clip's filmstrip
   * represent its own `[sourceIn, sourceOut]` window instead of always
   * starting from the underlying file's beginning. */
  startOffset?: number
}

const CAPTURE_WIDTH = 160
const CAPTURE_HEIGHT = 90
const REGEN_DEBOUNCE_MS = 250
const MEDIA_READY_TIMEOUT_MS = 8000
const FRAME_SEEK_TIMEOUT_MS = 4000

function waitForMedia(video: HTMLVideoElement, successEvent: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timeout)
      video.removeEventListener(successEvent, onSuccess)
      video.removeEventListener('error', onError)
      resolve(ok)
    }
    const onSuccess = (): void => finish(true)
    const onError = (): void => finish(false)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    video.addEventListener(successEvent, onSuccess, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

/** Real per-frame filmstrip for the V1 video track, extracted via an
 * offscreen <video> + <canvas> (seek -> draw -> toDataURL) rather than
 * tiling one static thumbnail -- a single repeated frame reads as broken
 * next to a real editor's timeline. Frames render progressively as they're
 * captured, and regeneration is debounced so scrubbing the zoom slider
 * doesn't trigger a burst of re-extraction.
 *
 * Viewport-gated: extraction only STARTS while this clip's filmstrip is
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
  const frameCount = frameCountForWidth(widthPx)
  const key = src && duration > 0 && widthPx > 0 ? filmstripCacheKey(src, startOffset, duration, frameCount) : null

  const [frames, setFrames] = useState<string[]>(() => (key ? (readFilmstripCache(key)?.frames ?? []) : []))
  const [failed, setFailed] = useState(false)
  const lastKeyRef = useRef(key)
  const [isVisible, setIsVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)
  /** The offscreen element the in-flight extraction is using, so cleanup can
   * actually tear its decoder down (see releaseVideo below). */
  const videoRef = useRef<HTMLVideoElement | null>(null)

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
    if (!key || !src) {
      setFrames((prev) => (prev.length === 0 ? prev : []))
      return
    }

    const cached = readFilmstripCache(key)
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key
      setFrames(cached?.frames ?? [])
      setFailed(false)
    }
    // Show whatever's already been extracted for this exact key immediately,
    // on the very first render after a remount -- no blank gap, no flicker.
    if (cached) setFrames(cached.frames)
    // Nothing left to do: every frame this width calls for is already cached.
    if (cached?.complete) return

    // Deliberately NOT clearing `frames` here. Scrolling out of the
    // virtualization window used to wipe completed frames, so coming back
    // re-decoded the whole strip from scratch; the frames on screen stay
    // valid until better ones replace them.
    if (!isVisible) return

    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current
      const video = document.createElement('video')
      videoRef.current = video
      video.src = src
      video.muted = true
      video.preload = 'auto'
      const canvas = document.createElement('canvas')
      canvas.width = CAPTURE_WIDTH
      canvas.height = CAPTURE_HEIGHT
      const ctx = canvas.getContext('2d')

      const captureAt = async (time: number): Promise<string | null> => {
        const seeked = waitForMedia(video, 'seeked', FRAME_SEEK_TIMEOUT_MS)
        try { video.currentTime = time } catch { return null }
        if (!await seeked || !ctx) return null
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          return canvas.toDataURL('image/jpeg', 0.6)
        } catch {
          return null
        }
      }

      const run = async (): Promise<void> => {
        if (video.readyState < 1 && !await waitForMedia(video, 'loadedmetadata', MEDIA_READY_TIMEOUT_MS)) {
          if (requestIdRef.current === requestId) setFailed(true)
          return
        }
        // Resume rather than restart: an earlier run for this same key may
        // have been cut short by the clip scrolling out of view.
        const results: string[] = [...(readFilmstripCache(key)?.frames ?? [])]
        for (let i = results.length; i < frameCount; i++) {
          if (requestIdRef.current !== requestId) return
          const t = startOffset + Math.min(Math.max(0, duration - 0.05), (duration * (i + 0.5)) / frameCount)
          const frame = await captureAt(t)
          if (requestIdRef.current !== requestId) return
          if (!frame) continue
          results.push(frame)
          writeFilmstripCache(key, { frames: [...results], complete: results.length >= frameCount })
          setFrames([...results])
        }
        // Ran the whole range: mark it done even if individual captures came
        // back empty, so a frame this file simply can't decode isn't retried
        // from scratch on every remount forever.
        if (requestIdRef.current === requestId) {
          writeFilmstripCache(key, { frames: [...results], complete: true })
          if (results.length === 0) setFailed(true)
        }
      }

      void run().finally(() => {
        // Only the run that's still current owns the element -- a superseded
        // one already had its own released by the cleanup that superseded it.
        if (requestIdRef.current === requestId) releaseVideo(videoRef)
      })
    }, REGEN_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      requestIdRef.current++
      // Each extraction's offscreen <video> is a real Chromium
      // WebMediaPlayer holding a decoder and buffered frames. Aborting a run
      // without this left one dangling per abort, waiting on GC -- with
      // virtualization remounting clips constantly while dragging, they
      // piled up fast, which is the other half of why this got slow.
      releaseVideo(videoRef)
    }
  }, [isVisible, src, key, duration, frameCount, startOffset])

  return (
    <div className="video-filmstrip" ref={containerRef}>
      {failed && frames.length === 0 && <span className="video-filmstrip-error">Preview unavailable</span>}
      {frames.map((frame, i) => (
        <img key={i} src={frame} alt="" className="video-filmstrip-frame" draggable={false} />
      ))}
    </div>
  )
}

/** Tears the offscreen element's media pipeline down immediately instead of
 * leaving it to garbage collection. `load()` after dropping the src is what
 * actually makes Chromium release the underlying WebMediaPlayer. */
function releaseVideo(ref: React.MutableRefObject<HTMLVideoElement | null>): void {
  const video = ref.current
  if (!video) return
  ref.current = null
  try {
    video.pause()
    video.removeAttribute('src')
    video.load()
  } catch {
    // Already torn down / detached -- nothing left to release.
  }
}
