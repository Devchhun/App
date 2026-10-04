import { useEffect, useRef, useState } from 'react'
import { captureOrder, frameCountForWidth, frameForSlot, filmstripCacheKey, nextSlotToCapture, readFilmstripCache, writeFilmstripCache } from './filmstripCache'

interface Props {
  src: string | undefined
  duration: number
  widthPx: number
  /** Source-seconds to start sampling from -- lets a trimmed clip's filmstrip
   * represent its own `[sourceIn, sourceOut]` window instead of always
   * starting from the underlying file's beginning. */
  startOffset?: number
  /** The video's thumbnail: every slot shows it until its own frame is
   * read, so a clip just added is a full strip at once. */
  poster?: string
}

const CAPTURE_WIDTH = 160
const CAPTURE_HEIGHT = 90
const REGEN_DEBOUNCE_MS = 250
const MEDIA_READY_TIMEOUT_MS = 8000
const FRAME_SEEK_TIMEOUT_MS = 4000

/** Filmstrips extracting at once. Video Sync can cut one long video into
 * hundreds of clips; twenty of them on screen used to open twenty decoders
 * on the same file together, and the slowest ran out of their timeouts. The
 * rest wait their turn -- waiting does not count against any timeout. */
const MAX_CONCURRENT_EXTRACTIONS = 4
let runningExtractions = 0
const waitingExtractions: (() => void)[] = []

function acquireExtractionSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      runningExtractions++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        runningExtractions--
        waitingExtractions.shift()?.()
      })
    }
    if (runningExtractions < MAX_CONCURRENT_EXTRACTIONS) grant()
    else waitingExtractions.push(grant)
  })
}

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

/** Slots kept around the visible ones: drawn and read just before they
 * scroll into view. */
const MARGIN_SLOTS = 6
/** How long a finished run keeps its decoder open for the next scroll. */
const IDLE_KEEP_MS = 1500

/** Real per-frame filmstrip for a video clip, CapCut style: the clip is cut
 * into fixed slots about a thumbnail wide, each showing its own moment.
 * Frames are extracted via an offscreen <video> + <canvas> (seek -> draw ->
 * toDataURL), and only for the slots on screen: a 47-minute clip is ~850
 * slots, of which a dozen or so are visible -- those are read (coarse to
 * fine) and drawn, the rest as they scroll into view. Until a slot's own
 * frame is read it shows the nearest one read so far, or the video's
 * thumbnail, so a clip just added is a full strip at once and nothing
 * moves as frames arrive.
 *
 * Viewport-gated too: extraction only STARTS while this clip is (near)
 * visible in the Timeline's own scroll container. Every mounted filmstrip
 * used to spin up its own offscreen <video> (a real WebMediaPlayer)
 * regardless of scroll position, and hundreds of clips exceeded Chromium's
 * per-page WebMediaPlayer limit. */
export function VideoFilmstrip({ src, duration, widthPx, startOffset = 0, poster }: Props): JSX.Element {
  const frameCount = frameCountForWidth(widthPx)
  const key = src && duration > 0 && widthPx > 0 ? filmstripCacheKey(src, startOffset, duration, frameCount) : null

  const [frames, setFrames] = useState<(string | null)[]>(() => (key ? (readFilmstripCache(key)?.frames ?? []) : []))
  const [failed, setFailed] = useState(false)
  const lastKeyRef = useRef(key)
  const [isVisible, setIsVisible] = useState(false)
  /** Slots on screen, with MARGIN_SLOTS either side (inclusive). */
  const [view, setView] = useState<{ from: number; to: number } | null>(null)
  const viewRef = useRef(view)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)
  /** The offscreen element the in-flight extraction is using, so cleanup can
   * actually tear its decoder down (see releaseVideo below). */
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const runningRef = useRef(false)
  /** Wakes a run waiting for the Timeline to scroll. */
  const wakeRef = useRef<(() => void) | null>(null)
  /** Starts a new run when one is not going (bumped on scroll). */
  const [wakeTick, setWakeTick] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), {
      root: el.closest('.timeline-scroll-2d'),
      rootMargin: '200px 400px',
      threshold: 0
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Which slots are on screen, kept current while the Timeline scrolls,
  // zooms or resizes.
  useEffect(() => {
    if (!isVisible) return
    const el = containerRef.current
    const root = el?.closest('.timeline-scroll-2d')
    if (!el || !root) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const box = el.getBoundingClientRect()
      const area = root.getBoundingClientRect()
      let next: { from: number; to: number } | null = null
      if (box.width > 0) {
        const from = Math.floor(((Math.max(area.left, box.left) - box.left) / box.width) * frameCount) - MARGIN_SLOTS
        const to = Math.floor(((Math.min(area.right, box.right) - box.left) / box.width) * frameCount) + MARGIN_SLOTS
        if (to >= from) next = { from: Math.max(0, from), to: Math.min(frameCount - 1, to) }
      }
      const prev = viewRef.current
      if (prev?.from === next?.from && prev?.to === next?.to) return
      viewRef.current = next
      setView(next)
      if (runningRef.current) wakeRef.current?.()
      else setWakeTick((t) => t + 1)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resize = new ResizeObserver(schedule)
    resize.observe(el)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resize.disconnect()
    }
  }, [isVisible, frameCount])

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
    if (cached?.complete) return
    // Deliberately NOT clearing `frames` here: the frames on screen stay
    // valid until better ones replace them.
    if (!isVisible) return
    const order = captureOrder(frameCount)
    const results: (string | null)[] = Array.from({ length: frameCount }, (_, i) => cached?.frames[i] ?? null)
    const tried = new Set(results.flatMap((frame, i) => (frame ? [i] : [])))
    // Nothing on screen left to read: no decoder needed.
    if (viewRef.current && nextSlotToCapture(order, tried, viewRef.current) === null) return

    const extract = async (requestId: number): Promise<void> => {
      const release = await acquireExtractionSlot()
      // Scrolled away (or replaced) while waiting for a slot.
      if (requestIdRef.current !== requestId) {
        release()
        return
      }
      runningRef.current = true
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
        if (!await seeked || !ctx || video.error) return null
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          return canvas.toDataURL('image/jpeg', 0.6)
        } catch {
          return null
        }
      }
      const waitForScroll = (): Promise<boolean> =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            wakeRef.current = null
            resolve(false)
          }, IDLE_KEEP_MS)
          wakeRef.current = () => {
            clearTimeout(timer)
            wakeRef.current = null
            resolve(true)
          }
        })

      const run = async (): Promise<void> => {
        if (video.readyState < 1 && !await waitForMedia(video, 'loadedmetadata', MEDIA_READY_TIMEOUT_MS)) {
          if (requestIdRef.current === requestId) setFailed(true)
          return
        }
        for (;;) {
          if (requestIdRef.current !== requestId) return
          const visible = viewRef.current
          const i = visible ? nextSlotToCapture(order, tried, visible) : null
          if (i === null) {
            // Everything on screen is read: keep the decoder a moment for
            // the next scroll, then let it go.
            if (await waitForScroll()) continue
            return
          }
          tried.add(i)
          // The file stopped decoding (a damaged file): every further seek
          // would only wait out its timeout.
          if (video.error) return
          const t = startOffset + Math.min(Math.max(0, duration - 0.05), (duration * (i + 0.5)) / frameCount)
          const frame = await captureAt(t)
          if (requestIdRef.current !== requestId) return
          if (!frame) continue
          results[i] = frame
          writeFilmstripCache(key, { frames: [...results], complete: results.every(Boolean) })
          setFrames([...results])
        }
      }

      await run().finally(() => {
        release()
        wakeRef.current = null
        // Only the run that's still current owns the element -- a superseded
        // one already had its own released by the cleanup that superseded it.
        if (requestIdRef.current === requestId) {
          runningRef.current = false
          releaseVideo(videoRef)
        }
      })
    }

    const timer = setTimeout(() => void extract(++requestIdRef.current), REGEN_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      requestIdRef.current++
      runningRef.current = false
      wakeRef.current?.()
      // Each extraction's offscreen <video> is a real Chromium
      // WebMediaPlayer holding a decoder and buffered frames: torn down now,
      // not left to GC.
      releaseVideo(videoRef)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wakeTick restarts a finished run after a scroll; the run itself reads viewRef.
  }, [isVisible, src, key, duration, frameCount, startOffset, wakeTick])

  // Fixed slots, as CapCut lays them out: each its own stretch of the clip,
  // its frame at its natural width, never stretched. Frames used to be flex
  // items -- the first one filled the whole clip, two split it, three... --
  // the strip re-laid itself out with every frame read, which looked like it
  // was stuttering. Only the slots on screen are in the page.
  const anyFrame = frames.some(Boolean)
  const slots: number[] = []
  if (view) for (let i = view.from; i <= view.to; i++) slots.push(i)
  return (
    <div className="video-filmstrip" ref={containerRef}>
      {failed && !anyFrame && !poster ? (
        <span className="video-filmstrip-error">Preview unavailable</span>
      ) : (
        slots.map((i) => {
          const frame = frameForSlot(frames, i, poster)
          return (
            <div
              key={i}
              className="video-filmstrip-frame"
              style={{ left: `${(i * 100) / frameCount}%`, width: `${100 / frameCount}%`, backgroundImage: frame ? `url("${frame}")` : undefined }}
            />
          )
        })
      )}
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
