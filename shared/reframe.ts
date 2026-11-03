// Auto Reframe: a wide video filling a tall frame (or the other way round)
// with the "camera" following the people in it, as CapCut does. The faces
// found a few times a second (python-worker/reframe_runner.py) become a
// smooth camera path along the long axis, and that path becomes the clip's
// Position keyframes at Fill scale -- so the Player and Export (which reads
// position keyframes) both show it, and it can be adjusted like any other
// keyframe afterwards.

import { POSITION_REFERENCE_SHORT_SIDE } from './clipPosition'
import type { ClipKeyframe } from './keyframes'

/** One analysed moment: faces as [centre x, centre y, width, score], all
 * fractions of the picture. */
export interface ReframeSample {
  t: number
  faces: [number, number, number, number][]
}

export interface ReframePlan {
  /** The long axis the camera pans along. */
  axis: 'x' | 'y'
  /** How much of the picture the frame shows along that axis (0..1). */
  window: number
  /** Where the frame's centre is along the axis (0..1 of the picture) at
   * source time t. Two points at (almost) the same time are a cut. */
  points: { t: number; c: number }[]
}

/** Which way the frame cuts into the picture, or null when they have the
 * same shape (nothing to follow). Aspects are width / height. */
export function reframeWindow(videoAspect: number, frameAspect: number): { axis: 'x' | 'y'; window: number } | null {
  if (!(videoAspect > 0) || !(frameAspect > 0)) return null
  if (videoAspect > frameAspect * 1.01) return { axis: 'x', window: frameAspect / videoAspect }
  if (videoAspect < frameAspect / 1.01) return { axis: 'y', window: videoAspect / frameAspect }
  return null
}

/** Where to look in one moment: the middle of the group when the faces
 * that matter fit in the frame together; else the person the camera is
 * already on, while they are still there and not much smaller than the
 * biggest face -- two people of a size taking turns at being "biggest"
 * otherwise left the camera halfway between them, on neither; else the
 * biggest face. */
function subjectAt(sample: ReframeSample, axis: 'x' | 'y', window: number, current: number | null): number | null {
  if (sample.faces.length === 0) return null
  const along = (f: ReframeSample['faces'][number]): number => (axis === 'x' ? f[0] : f[1])
  const biggest = Math.max(...sample.faces.map((f) => f[2]))
  const main = sample.faces.filter((f) => f[2] >= biggest * 0.55)
  const positions = main.map(along)
  const lo = Math.min(...positions)
  const hi = Math.max(...positions)
  if (hi - lo <= window * 0.75) return (lo + hi) / 2
  if (current !== null) {
    const near = sample.faces.filter((f) => Math.abs(along(f) - current) < window * 0.35)
    if (near.length > 0) {
      const stay = near.reduce((a, b) => (b[2] > a[2] ? b : a))
      if (stay[2] * 1.6 >= biggest) return along(stay)
    }
  }
  const primary = sample.faces.reduce((a, b) => (b[2] > a[2] ? b : a))
  return along(primary)
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Ramer-Douglas-Peucker on (t, c): the fewest points within `epsilon`. */
function simplify(points: { t: number; c: number }[], epsilon: number): { t: number; c: number }[] {
  if (points.length <= 2) return points
  const first = points[0]
  const last = points[points.length - 1]
  let worst = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const span = last.t - first.t
    const expected = span <= 0 ? first.c : first.c + ((p.t - first.t) / span) * (last.c - first.c)
    const d = Math.abs(p.c - expected)
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (worst <= epsilon) return [first, last]
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)]
}

/** The camera path: steady while the people stay in view, gliding when
 * they move, cutting straight across with the video's own cuts. */
export function planReframe(samples: ReframeSample[], videoAspect: number, frameAspect: number): ReframePlan | null {
  const shape = reframeWindow(videoAspect, frameAspect)
  if (!shape || samples.length === 0) return null
  const { axis, window } = shape
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  // Moments with nobody: the camera holds where it was.
  let current: number | null = null
  const raw = sorted.map((s) => {
    const at = subjectAt(s, axis, window, current)
    if (at !== null) current = at
    return at
  })
  const firstKnown = raw.find((v) => v !== null) ?? 0.5
  let held = firstKnown
  const targets = raw.map((v) => (v === null ? held : (held = v)))
  // The video's own cuts: a big jump that stays (the next moment agrees).
  // Found on the raw positions -- found after smoothing they came a second
  // late -- and nothing is smoothed across one.
  const cutAt = new Set<number>()
  for (let i = 1; i < targets.length; i++) {
    const jump = Math.abs(targets[i] - targets[i - 1]) > window * 0.5
    const stays = i + 1 >= targets.length || Math.abs(targets[i + 1] - targets[i]) < window * 0.25
    if (jump && stays) cutAt.add(i)
  }
  const lo = window / 2
  const hi = 1 - window / 2
  const smooth: number[] = []
  let shotStart = 0
  for (let i = 1; i <= targets.length; i++) {
    if (i < targets.length && !cutAt.has(i)) continue
    const shot = targets.slice(shotStart, i)
    // One stray detection is not a move.
    const steady = shot.map((_, j) => median(shot.slice(Math.max(0, j - 1), j + 2)))
    // A dead zone, then a soft glide: small shifts of the face do not move
    // the camera; a real move is followed smoothly.
    let cam = steady[0]
    const path: number[] = []
    for (const target of steady) {
      const gap = target - cam
      const dead = window * 0.06
      if (Math.abs(gap) > dead) cam += (gap - Math.sign(gap) * dead) * 0.8
      path.push(cam)
    }
    // A light average over about a second and a half.
    for (let j = 0; j < path.length; j++) {
      const around = path.slice(Math.max(0, j - 1), j + 2)
      smooth.push(around.reduce((x, y) => x + y, 0) / around.length)
    }
    shotStart = i
  }
  const clamp = (c: number): number => Math.min(hi, Math.max(lo, c))
  const points: { t: number; c: number }[] = []
  const step = sorted.length > 1 ? (sorted[sorted.length - 1].t - sorted[0].t) / (sorted.length - 1) : 0.5
  let run: { t: number; c: number }[] = []
  const flush = (): void => {
    points.push(...simplify(run, window * 0.02))
    run = []
  }
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && cutAt.has(i)) {
      // Cut between the two moments: the old view to just before it, the
      // new one from just after.
      const middle = (sorted[i - 1].t + sorted[i].t) / 2
      run.push({ t: middle - 0.02, c: clamp(smooth[i - 1]) })
      flush()
      run.push({ t: middle, c: clamp(smooth[i]) })
    }
    run.push({ t: sorted[i].t, c: clamp(smooth[i]) })
  }
  flush()
  void step
  return { axis, window, points }
}

/** The plan's centre at source time t. */
export function reframeCentreAt(plan: ReframePlan, t: number): number {
  const p = plan.points
  if (p.length === 0) return 0.5
  if (t <= p[0].t) return p[0].c
  if (t >= p[p.length - 1].t) return p[p.length - 1].c
  for (let i = 0; i < p.length - 1; i++) {
    if (t >= p[i].t && t <= p[i + 1].t) {
      const span = p[i + 1].t - p[i].t
      return span <= 0 ? p[i + 1].c : p[i].c + ((t - p[i].t) / span) * (p[i + 1].c - p[i].c)
    }
  }
  return p[p.length - 1].c
}

/** What Auto Reframe puts on one clip: the Fill scale and the Position
 * keyframes (times in the clip, values in Position's reference units)
 * that keep the plan's centre in the middle of the frame. `mirrored`: the
 * clip is flipped on that axis (Mirror), so the picture's left is on the
 * right. */
export function reframeClip(
  plan: ReframePlan,
  clip: { sourceIn: number; sourceOut?: number; duration: number; playbackRate?: number },
  frameAspect: number,
  mirrored: boolean,
  makeId: () => string
): { scale: number; property: 'x' | 'y'; keyframes: ClipKeyframe[] } {
  // A frame of this shape with its short side at the reference size: one
  // pixel of it is one Position unit (shared/clipPosition.ts).
  const width = frameAspect >= 1 ? POSITION_REFERENCE_SHORT_SIDE * frameAspect : POSITION_REFERENCE_SHORT_SIDE
  const height = frameAspect >= 1 ? POSITION_REFERENCE_SHORT_SIDE : POSITION_REFERENCE_SHORT_SIDE / frameAspect
  const span = plan.axis === 'x' ? width : height
  // Fill: the picture's long side grows until the short one fills the frame.
  const scale = 1 / plan.window
  const room = (span * scale - span) / 2
  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1
  const sourceEnd = clip.sourceOut ?? clip.sourceIn + clip.duration * rate
  const valueAt = (c: number): number => {
    const offset = (0.5 - c) * span * scale * (mirrored ? -1 : 1)
    return Math.round(Math.min(room, Math.max(-room, offset)) * 100) / 100
  }
  const times = [clip.sourceIn, ...plan.points.map((p) => p.t).filter((t) => t > clip.sourceIn && t < sourceEnd), sourceEnd]
  const keyframes: ClipKeyframe[] = []
  for (const t of times) {
    const time = Math.round(((t - clip.sourceIn) / rate) * 1000) / 1000
    const value = valueAt(reframeCentreAt(plan, t))
    const last = keyframes[keyframes.length - 1]
    if (last && Math.abs(last.time - time) < 1e-6) continue
    keyframes.push({ id: makeId(), time, value, easing: 'linear' })
  }
  // A steady shot needs one keyframe, not a line of equal ones.
  const varies = keyframes.some((k) => Math.abs(k.value - keyframes[0].value) > 0.5)
  return { scale, property: plan.axis, keyframes: varies ? keyframes : keyframes.slice(0, 1) }
}

export const REFRAME_IPC = {
  analyze: 'reframe:analyze',
  cancel: 'reframe:cancel',
  progress: 'reframe:progress'
} as const

/** What one video file holds for Auto Reframe: its picture size and the
 * faces found through it (source seconds). Kept per file. */
export interface ReframeAnalysis {
  width: number
  height: number
  samples: ReframeSample[]
}

export type ReframeAnalyzeResult = { ok: true; analysis: ReframeAnalysis } | { ok: false; error: string; canceled?: boolean }

export interface ReframeProgress {
  jobId: string
  /** 0..100 for the file being looked through. */
  percent: number
}
