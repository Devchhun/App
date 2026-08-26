// Magnetic snapping (spec section 4) -- an independent toggle from Magnet
// (magnet.ts, which is about the main track staying gapless) and Ripple
// (ripple.ts). Snapping just pulls a dragged edge/clip toward nearby times
// -- timeline start, playhead, other clip edges, markers, in/out range,
// caption/scene boundaries, the selected clip(s)' own boundaries -- within a
// SCREEN-SPACE threshold (so it feels consistent at any zoom level).
// buildSnapCandidates is meant to be called once per pointerdown (the
// candidate set is frozen for the whole drag); findSnapMatch runs cheaply on
// every pointermove against that frozen list.
import type { TimelineClip, Marker } from '@shared/project'

export type SnapKind =
  | 'timeline-start'
  | 'playhead'
  | 'clip-start'
  | 'clip-end'
  | 'marker'
  | 'in-point'
  | 'out-point'
  | 'caption-boundary'
  | 'scene-boundary'
  | 'selected-boundary'

export interface SnapCandidate {
  time: number
  kind: SnapKind
  label?: string
}

export interface BuildSnapCandidatesParams {
  clips: TimelineClip[]
  markers: Marker[]
  scenes: { startTime: number; endTime: number }[]
  captionSegments: { startTime: number; endTime: number }[]
  playheadTime: number
  inOutRange?: { start: number; end: number } | null
  /** The clip(s) being dragged -- excluded so a clip never snaps to its own
   * (currently-moving) edges. */
  excludeClipIds?: Set<string>
  /** Clips in the current selection (other than the one being dragged) get
   * the more specific 'selected-boundary' kind instead of plain clip-start/
   * end, for UI purposes (e.g. a different guide-line label). */
  selectedClipIds?: Set<string>
}

export function buildSnapCandidates(params: BuildSnapCandidatesParams): SnapCandidate[] {
  const exclude = params.excludeClipIds ?? new Set<string>()
  const selected = params.selectedClipIds ?? new Set<string>()
  const candidates: SnapCandidate[] = [
    { time: 0, kind: 'timeline-start' },
    { time: params.playheadTime, kind: 'playhead' }
  ]

  for (const c of params.clips) {
    if (exclude.has(c.id)) continue
    const isSelected = selected.has(c.id)
    candidates.push({ time: c.startTime, kind: isSelected ? 'selected-boundary' : 'clip-start' })
    candidates.push({ time: c.startTime + c.duration, kind: isSelected ? 'selected-boundary' : 'clip-end' })
  }
  for (const m of params.markers) candidates.push({ time: m.time, kind: 'marker', label: m.name })
  for (const s of params.scenes) {
    candidates.push({ time: s.startTime, kind: 'scene-boundary' })
    candidates.push({ time: s.endTime, kind: 'scene-boundary' })
  }
  for (const seg of params.captionSegments) {
    candidates.push({ time: seg.startTime, kind: 'caption-boundary' })
    candidates.push({ time: seg.endTime, kind: 'caption-boundary' })
  }
  if (params.inOutRange) {
    candidates.push({ time: params.inOutRange.start, kind: 'in-point' })
    candidates.push({ time: params.inOutRange.end, kind: 'out-point' })
  }

  return candidates
}

export interface SnapMatch {
  time: number
  snapped: boolean
  candidate?: SnapCandidate
}

/** The closest candidate to `rawTime` within `thresholdPx` screen pixels
 * (converted to seconds via `thresholdPx / pixelsPerSecond`, so the same
 * pixel threshold feels equally "sticky" at any zoom level) -- ties broken
 * by whichever candidate is closest. Returns `rawTime` unchanged with
 * `snapped: false` when nothing is within range. */
export function findSnapMatch(rawTime: number, candidates: SnapCandidate[], thresholdPx: number, pixelsPerSecond: number): SnapMatch {
  const thresholdSeconds = pixelsPerSecond > 0 ? thresholdPx / pixelsPerSecond : 0
  let best: SnapCandidate | undefined
  let bestDist = Infinity
  for (const c of candidates) {
    const dist = Math.abs(c.time - rawTime)
    if (dist <= thresholdSeconds && dist < bestDist) {
      best = c
      bestDist = dist
    }
  }
  if (!best) return { time: rawTime, snapped: false }
  return { time: best.time, snapped: true, candidate: best }
}
