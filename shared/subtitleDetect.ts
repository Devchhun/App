/** Finds where a video's own (burned-in) subtitles sit, from a few grey
 * frames taken while lines are spoken, so the blur box can be placed on
 * them automatically.
 *
 * Subtitle text is bright strokes with sharp edges, always in the same band
 * of the frame, while its content changes from line to line. So: count, per
 * pixel, how often it is a bright sharp edge; drop pixels that never change
 * at all (a logo, a watermark, a letterbox edge); then take the band of
 * rows -- lower half first, top quarter as a fallback -- where those edges
 * are densest, and the columns they span inside it. */

export interface DetectedBand {
  /** Fractions (0-1) of the frame. */
  x: number
  y: number
  w: number
  h: number
  /** How strongly the band stands out (0-1); for logging/thresholds. */
  score: number
}

const EDGE_STEP = 45
const BRIGHT = 150
const STATIC_STD = 5

export function findSubtitleBand(frames: Uint8Array[], width: number, height: number): DetectedBand | null {
  if (frames.length === 0 || width < 8 || height < 8) return null
  const n = width * height
  const hits = new Float32Array(n)
  for (const frame of frames) {
    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 1; x < width - 1; x++) {
        const i = row + x
        const left = frame[i - 1]
        const right = frame[i + 1]
        const step = Math.abs(right - left)
        if (step > EDGE_STEP && Math.max(left, frame[i], right) > BRIGHT) hits[i] += 1
      }
    }
  }
  // A pixel that is the same in every frame is not subtitle text.
  if (frames.length >= 4) {
    for (let i = 0; i < n; i++) {
      if (hits[i] === 0) continue
      let sum = 0
      let sq = 0
      for (const frame of frames) {
        sum += frame[i]
        sq += frame[i] * frame[i]
      }
      const mean = sum / frames.length
      if (Math.sqrt(Math.max(0, sq / frames.length - mean * mean)) < STATIC_STD) hits[i] = 0
    }
  }
  for (let i = 0; i < n; i++) hits[i] /= frames.length

  const rows = new Float32Array(height)
  for (let y = 0; y < height; y++) {
    let s = 0
    for (let x = 0; x < width; x++) s += hits[y * width + x]
    rows[y] = s / width
  }
  const smooth = new Float32Array(height)
  for (let y = 0; y < height; y++) smooth[y] = (rows[Math.max(0, y - 1)] + rows[y] + rows[Math.min(height - 1, y + 1)]) / 3

  const bestIn = (from: number, to: number): { y: number; v: number } => {
    let best = { y: -1, v: 0 }
    for (let y = from; y < to; y++) if (smooth[y] > best.v) best = { y, v: smooth[y] }
    return best
  }
  // Subtitles are nearly always in the lower half; a top band only counts
  // when the bottom has nothing comparable.
  const bottom = bestIn(Math.floor(height * 0.5), height)
  const top = bestIn(0, Math.floor(height * 0.25))
  const peak = bottom.v >= top.v * 0.6 ? bottom : top
  const MIN_ROW_DENSITY = 0.01
  if (peak.y < 0 || peak.v < MIN_ROW_DENSITY) return null
  // The band has to stand out from the picture around it: a busy, moving
  // scene (a tiled wall, measured) has bright edges on every row, and a
  // threshold relative to the peak alone then took the whole frame.
  const sorted = Array.from(smooth).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (peak.v < median * 1.4) return null
  const threshold = Math.max(peak.v * 0.3, median + (peak.v - median) * 0.5)
  // Two lines of subtitles at most: never taller than this.
  const maxRows = Math.max(3, Math.round(height * 0.2))
  let y0 = peak.y
  let y1 = peak.y
  while (y0 > 0 && smooth[y0 - 1] > threshold && y1 - y0 + 1 < maxRows) y0--
  while (y1 < height - 1 && smooth[y1 + 1] > threshold && y1 - y0 + 1 < maxRows) y1++

  const cols = new Float32Array(width)
  for (let x = 0; x < width; x++) {
    let s = 0
    for (let y = y0; y <= y1; y++) s += hits[y * width + x]
    cols[x] = s / (y1 - y0 + 1)
  }
  let colPeak = 0
  for (let x = 0; x < width; x++) colPeak = Math.max(colPeak, cols[x])
  // Columns: denser than the same rows' background (the median column).
  const colMedian = Array.from(cols).sort((a, b) => a - b)[Math.floor(width / 2)]
  const colThreshold = Math.max(colPeak * 0.12, colMedian * 0.6)
  const active: number[] = []
  for (let x = 0; x < width; x++) if (cols[x] > colThreshold) active.push(x)
  if (active.length === 0) return null
  // Ignore a few stray columns at either end.
  const trim = Math.floor(active.length * 0.02)
  const x0 = active[trim]
  const x1 = active[active.length - 1 - trim]

  // Subtitles are centred: a band whose middle is near the frame's middle
  // is widened to the same reach on both sides, so a line longer than the
  // sampled ones is still covered.
  let left = x0
  let right = x1
  const mid = (width - 1) / 2
  if (Math.abs((x0 + x1) / 2 - mid) < width * 0.15) {
    const reach = Math.max(mid - x0, x1 - mid)
    left = Math.max(0, Math.round(mid - reach))
    right = Math.min(width - 1, Math.round(mid + reach))
  }
  const bandH = y1 - y0 + 1
  const padY = Math.max(2, bandH * 0.6)
  const padX = width * 0.03
  const fx = Math.max(0, (left - padX) / width)
  const fy = Math.max(0, (y0 - padY) / height)
  const fw = Math.min(1 - fx, (right - left + 1 + 2 * padX) / width)
  const fh = Math.min(1 - fy, (bandH + 2 * padY) / height)
  return { x: fx, y: fy, w: fw, h: fh, score: Math.min(1, peak.v * 10) }
}

/** Up to `count` moments to look at: the middle of each subtitle line (the
 * original subtitles are on screen then), spread across the video. */
export function pickSampleTimes(lineMiddles: number[], count = 24): number[] {
  const sorted = [...lineMiddles].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
  if (sorted.length <= count) return sorted
  const step = sorted.length / count
  return Array.from({ length: count }, (_, i) => sorted[Math.floor(i * step + step / 2)])
}
