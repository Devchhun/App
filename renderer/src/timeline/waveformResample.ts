import type { WaveformData } from '@shared/media'

export interface WaveformBar {
  min: number
  max: number
}

/** Resamples a full-file WaveformData down to exactly `widthPx` bars, one per
 * screen pixel, each covering the slice of SOURCE time that pixel represents
 * within a clip's trimmed [sourceIn, sourceIn+duration) window. Zooming in
 * shrinks source-time-per-pixel, so more of the underlying fixed-count
 * cached buckets get sampled into more, finer bars -- real added detail --
 * instead of the same fixed bar count simply stretching wider. Pure/testable
 * on its own; WaveformTrack.tsx only draws whatever this returns. Returns
 * an empty array for any degenerate input (no data, non-positive duration). */
export function computeWaveformBars(
  waveform: WaveformData | undefined,
  sourceDurationSeconds: number,
  sourceIn: number,
  duration: number,
  widthPx: number
): WaveformBar[] {
  const w = Math.max(0, Math.round(widthPx))
  if (!waveform || waveform.peaks.length === 0 || sourceDurationSeconds <= 0 || duration <= 0 || w === 0) return []

  const totalBuckets = waveform.bucketCount
  const bucketDuration = sourceDurationSeconds / totalBuckets
  const bars: WaveformBar[] = []

  for (let x = 0; x < w; x++) {
    const tStart = sourceIn + (x / w) * duration
    const tEnd = sourceIn + ((x + 1) / w) * duration
    const bStart = Math.max(0, Math.floor(tStart / bucketDuration))
    const bEnd = Math.min(totalBuckets - 1, Math.floor(tEnd / bucketDuration))
    let min = 0
    let max = 0
    for (let b = bStart; b <= bEnd; b++) {
      const bMin = waveform.peaks[b * 2]
      const bMax = waveform.peaks[b * 2 + 1]
      if (bMin < min) min = bMin
      if (bMax > max) max = bMax
    }
    bars.push({ min, max })
  }

  return bars
}
