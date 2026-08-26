import { useEffect, useRef } from 'react'
import type { WaveformData } from '@shared/media'

interface Props {
  waveform?: WaveformData
  duration: number
  pixelsPerSecond: number
}

const TRACK_HEIGHT = 48

export function WaveformTrack({ waveform, duration, pixelsPerSecond }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const widthPx = Math.max(1, Math.round(duration * pixelsPerSecond))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = widthPx * dpr
    canvas.height = TRACK_HEIGHT * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, widthPx, TRACK_HEIGHT)

    if (!waveform || waveform.peaks.length === 0) {
      ctx.fillStyle = '#8a8f98'
      ctx.font = '11px sans-serif'
      ctx.fillText('No audio waveform', 8, TRACK_HEIGHT / 2 + 4)
      return
    }

    const bucketCount = waveform.bucketCount
    const mid = TRACK_HEIGHT / 2
    ctx.fillStyle = '#5b8cff'
    for (let i = 0; i < bucketCount; i++) {
      const min = waveform.peaks[i * 2]
      const max = waveform.peaks[i * 2 + 1]
      const x = (i / bucketCount) * widthPx
      const barWidth = Math.max(1, widthPx / bucketCount)
      const yTop = mid - max * mid
      const yBottom = mid - min * mid
      ctx.fillRect(x, yTop, barWidth, Math.max(1, yBottom - yTop))
    }
  }, [waveform, widthPx])

  return (
    <div className="timeline-track timeline-track-waveform" style={{ width: widthPx, height: TRACK_HEIGHT }}>
      <canvas ref={canvasRef} style={{ width: widthPx, height: TRACK_HEIGHT }} />
    </div>
  )
}
