import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import type { TimelineClip } from '@shared/project'
import { adjustCssFilter, backgroundBlurSigma } from '@shared/clipAdjust'

/** The canvas is drawn this small and enlarged by CSS: a blur this soft
 * shows no detail anyway, and a tiny drawImage per frame costs nothing. */
const DRAW_WIDTH = 96

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

/** Background > Blur in the Player: behind the main video, its own frames
 * enlarged to fill the stage and blurred -- what fills the empty bars. The
 * same size of blur (a share of the frame's height), colours and
 * way-round as Export (shared/export.ts). */
export function BackgroundBlurLayer({
  videoRef,
  clip,
  stageSize,
  opacity
}: {
  videoRef: RefObject<HTMLVideoElement>
  clip: TimelineClip
  stageSize: { width: number; height: number } | null
  /** The clip's own, as it fades (shared/pictureFade.ts). */
  opacity?: CSSProperties['opacity']
}): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const width = stageSize?.width ?? 0
  const height = stageSize?.height ?? 0

  useEffect(() => {
    const video = videoRef.current as VideoWithFrameCallback | null
    const canvas = canvasRef.current
    if (!video || !canvas || width <= 0 || height <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = DRAW_WIDTH
    canvas.height = Math.max(1, Math.round((DRAW_WIDTH * height) / width))
    let stopped = false
    let frameId: number | null = null
    const draw = (): void => {
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh || video.readyState < 2) return
      // Enlarged to cover the whole canvas, centred (cut at the long sides).
      const scale = Math.max(canvas.width / vw, canvas.height / vh)
      const dw = vw * scale
      const dh = vh * scale
      try {
        ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh)
      } catch {
        // A frame not ready to be read: the next one draws.
      }
    }
    const onFrame = (): void => {
      if (stopped) return
      draw()
      frameId = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(onFrame) : null
    }
    // Every new frame while playing; and the frame shown after a seek.
    if (video.requestVideoFrameCallback) frameId = video.requestVideoFrameCallback(onFrame)
    const events = ['loadeddata', 'seeked', 'timeupdate'] as const
    for (const e of events) video.addEventListener(e, draw)
    draw()
    return () => {
      stopped = true
      if (frameId !== null) video.cancelVideoFrameCallback?.(frameId)
      for (const e of events) video.removeEventListener(e, draw)
    }
  }, [videoRef, width, height, clip.mediaId])

  if (!stageSize || !clip.backgroundBlur) return null
  const sigma = backgroundBlurSigma(clip.backgroundBlur, height)
  const adjust = adjustCssFilter(clip.adjust)
  const flipX = (clip.transform?.scaleX ?? 1) < 0 ? -1 : 1
  const flipY = (clip.transform?.scaleY ?? 1) < 0 ? -1 : 1
  return (
    <canvas
      ref={canvasRef}
      className="preview-background-blur"
      aria-hidden
      style={{
        opacity,
        // A little larger than the stage: a blur fades out at its edges.
        transform: `scale(${1.12 * flipX}, ${1.12 * flipY})`,
        filter: `${adjust ? `${adjust} ` : ''}blur(${sigma.toFixed(1)}px)`
      }}
    />
  )
}
