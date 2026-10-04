/** Video Sync's plan, shared by the desktop (renderer/src/dubbing/videoSync.ts)
 * and the phone. */

/** Video Sync -- the other way to fit a Khmer line that is longer than the
 * original: instead of speeding the voice up (Auto-Speed, capped at 1.25x
 * because a faster voice was what made lines unclear), the picture under
 * that line plays a little slower, and everything after it moves later.
 *
 * Never slower than this, counting any slow-down already applied: past it a
 * scene visibly drags. A line that still does not fit runs a little late,
 * as before. */
export const VIDEO_SYNC_MIN_RATE = 0.85
/** A breath after the line before the next one starts. */
const BREATH_SECONDS = 0.05

export interface VideoSyncLine {
  /** The subtitle's start, Timeline seconds. */
  start: number
  /** Room until the next subtitle starts (its own length for the last). */
  room: number
  /** The dubbed take's length on the Timeline. */
  clipSeconds: number
  /** The picture's current rate at this line (1 unless already slowed). */
  videoRate: number
}

/** One stretch of the Timeline [start, end) played at `rate` (< 1). */
export interface VideoSyncRegion {
  start: number
  end: number
  rate: number
}

/** Which lines' room is slowed, and by how much. */
export function planVideoSync(lines: VideoSyncLine[]): VideoSyncRegion[] {
  const regions: VideoSyncRegion[] = []
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    if (!(line.room > 0)) continue
    const needed = line.clipSeconds + BREATH_SECONDS
    if (needed <= line.room + 0.02) continue
    const floor = VIDEO_SYNC_MIN_RATE / Math.max(VIDEO_SYNC_MIN_RATE, line.videoRate || 1)
    const rate = Math.round(Math.max(floor, line.room / needed) * 1000) / 1000
    if (rate >= 0.995) continue
    const previous = regions[regions.length - 1]
    // Rooms run subtitle to subtitle, so they never overlap; guard anyway.
    if (previous && line.start < previous.end) continue
    regions.push({ start: line.start, end: line.start + line.room, rate })
  }
  return regions
}

/** Where a moment of the old Timeline lands once the regions are slowed. */
export function mapVideoSyncTime(regions: VideoSyncRegion[], time: number): number {
  let shift = 0
  for (const region of regions) {
    if (time <= region.start) break
    const added = (region.end - region.start) * (1 / region.rate - 1)
    if (time < region.end) return time + shift + (time - region.start) * (1 / region.rate - 1)
    shift += added
  }
  return time + shift
}

/** Seconds the whole Timeline grows by. */
export function videoSyncAddedSeconds(regions: VideoSyncRegion[]): number {
  return regions.reduce((total, region) => total + (region.end - region.start) * (1 / region.rate - 1), 0)
}
