// Looping motion for a clip on the picture (a logo that floats, bounces,
// circles, wanders around the screen...). One description per preset feeds
// both the Player (numbers, every frame) and Export (ffmpeg expressions of
// `t`), so the two move the same way. Distances are fractions of the frame
// height (or width, for Wander's sideways travel); speed divides the
// period, amount scales the distance.

export const CLIP_MOTION_PRESETS = ['float', 'bounce', 'sway', 'circle', 'figure8', 'zigzag', 'wander', 'pulse', 'spin', 'swing', 'shake'] as const
export type ClipMotionPreset = (typeof CLIP_MOTION_PRESETS)[number]

export interface ClipMotion {
  preset: ClipMotionPreset
  /** 0.25-3: 1 = the preset's own pace, 2 = twice as fast. */
  speed: number
  /** 0.1-1: how far (or how much) it moves. */
  amount: number
}

export const DEFAULT_CLIP_MOTION_SPEED = 1
export const DEFAULT_CLIP_MOTION_AMOUNT = 0.6

export const CLIP_MOTION_LABELS: Record<ClipMotionPreset, string> = {
  float: 'Float',
  bounce: 'Bounce',
  sway: 'Sway',
  circle: 'Circle',
  figure8: 'Figure 8',
  zigzag: 'Zigzag',
  wander: 'Wander',
  pulse: 'Pulse',
  spin: 'Spin',
  swing: 'Swing',
  shake: 'Shake'
}

export const CLIP_MOTION_HINTS: Record<ClipMotionPreset, string> = {
  float: 'Drifts gently up and down',
  bounce: 'Hops up and lands, again and again',
  sway: 'Glides left and right',
  circle: 'Goes round in a circle',
  figure8: 'Traces a figure 8',
  zigzag: 'Zigzags side to side',
  wander: 'Travels around the whole screen, bouncing off the edges',
  pulse: 'Grows and shrinks like a heartbeat',
  spin: 'Turns round and round',
  swing: 'Rocks like a pendulum',
  shake: 'Small quick shake'
}

/** One wave: amp x f(t / period). `sin` is a sine; `hop` |sin| (a bounce);
 * `tri` a triangle wave (straight there and back, -1..1); `turns` t/period
 * itself (endless rotation). */
interface Wave {
  shape: 'sin' | 'hop' | 'tri' | 'turns'
  period: number
  amp: number
  /** Fraction of a period added to the phase (0.25 turns a sine into a cosine). */
  phase?: number
  /** The distance is the room left between the picture and the frame's
   * edge on that side (Wander bounces off the edges exactly). */
  edges?: boolean
}

interface MotionSpec {
  x?: Wave
  y?: Wave
  /** Added to scale 1. */
  scale?: Wave
  /** Degrees. */
  rotate?: Wave
  /** Spin keeps its full turn whatever the amount. */
  fixedAmount?: boolean
}

const SPECS: Record<ClipMotionPreset, MotionSpec> = {
  float: { y: { shape: 'sin', period: 3, amp: -0.08 } },
  bounce: { y: { shape: 'hop', period: 1.2, amp: -0.14 } },
  sway: { x: { shape: 'sin', period: 3, amp: 0.14 } },
  circle: { x: { shape: 'sin', period: 4, amp: 0.12, phase: 0.25 }, y: { shape: 'sin', period: 4, amp: 0.12 } },
  figure8: { x: { shape: 'sin', period: 5, amp: 0.16 }, y: { shape: 'sin', period: 2.5, amp: 0.08 } },
  zigzag: { x: { shape: 'tri', period: 4, amp: 0.22 }, y: { shape: 'tri', period: 1, amp: 0.05 } },
  wander: { x: { shape: 'tri', period: 7, amp: 1, edges: true }, y: { shape: 'tri', period: 5.3, amp: 1, edges: true } },
  pulse: { scale: { shape: 'sin', period: 1.5, amp: 0.18 } },
  spin: { rotate: { shape: 'turns', period: 4, amp: 360 }, fixedAmount: true },
  swing: { rotate: { shape: 'sin', period: 2, amp: 18 } },
  shake: { x: { shape: 'sin', period: 0.14, amp: 0.02 }, y: { shape: 'sin', period: 0.19, amp: 0.015 } }
}

function clampMotion(motion: ClipMotion): { spec: MotionSpec; speed: number; amount: number } {
  const spec = SPECS[motion.preset] ?? SPECS.float
  const speed = Math.min(3, Math.max(0.25, motion.speed || DEFAULT_CLIP_MOTION_SPEED))
  const amount = spec.fixedAmount ? 1 : Math.min(1, Math.max(0.1, motion.amount || DEFAULT_CLIP_MOTION_AMOUNT))
  return { spec, speed, amount }
}

function waveValue(wave: Wave, t: number, speed: number, amount: number): number {
  const u = (t * speed) / wave.period + (wave.phase ?? 0)
  const f = wave.shape === 'sin' ? Math.sin(2 * Math.PI * u) : wave.shape === 'hop' ? Math.abs(Math.sin(Math.PI * u)) : wave.shape === 'tri' ? 1 - 4 * Math.abs(u - Math.floor(u) - 0.5) : u
  return wave.amp * amount * f
}

const num = (n: number): string => String(Math.round(n * 1e9) / 1e9)

/** The same wave as an ffmpeg expression of `time` (an expression too). */
function waveExpr(wave: Wave, time: string, speed: number, amount: number): string {
  const u = `(${time})*${num(speed / wave.period)}${wave.phase ? `+${num(wave.phase)}` : ''}`
  const f =
    wave.shape === 'sin'
      ? `sin(2*PI*(${u}))`
      : wave.shape === 'hop'
        ? `abs(sin(PI*(${u})))`
        : wave.shape === 'tri'
          ? `(1-4*abs((${u})-floor(${u})-0.5))`
          : `(${u})`
  return `${num(wave.amp * amount)}*${f}`
}

/** Where the motion has the clip at `t` seconds into it: offsets in frame
 * pixels, a scale factor, degrees. `picture` is the clip's size on the
 * frame (for motions that run to the edges; without it, most of the frame). */
export function clipMotionAt(
  motion: ClipMotion,
  t: number,
  frame: { width: number; height: number },
  picture?: { width: number; height: number }
): { dx: number; dy: number; scale: number; rotate: number } {
  const { spec, speed, amount } = clampMotion(motion)
  const room = (wave: Wave, axis: 'x' | 'y'): number => {
    if (!wave.edges) return frame.height
    const full = axis === 'x' ? frame.width : frame.height
    const size = picture ? (axis === 'x' ? picture.width : picture.height) : full * 0.16
    return Math.max(0, full - size) / 2
  }
  return {
    dx: spec.x ? waveValue(spec.x, t, speed, amount) * room(spec.x, 'x') : 0,
    dy: spec.y ? waveValue(spec.y, t, speed, amount) * room(spec.y, 'y') : 0,
    scale: 1 + (spec.scale ? waveValue(spec.scale, t, speed, amount) : 0),
    rotate: spec.rotate ? waveValue(spec.rotate, t, speed, amount) : 0
  }
}

/** The motion as ffmpeg expressions of `time` (seconds into the clip): dx/dy
 * for overlay x/y (in its W/H), scale as a factor, rotate in radians. Null
 * where the preset does not move that way. */
export function clipMotionExprs(motion: ClipMotion, time: string): { dx: string | null; dy: string | null; scale: string | null; rotate: string | null } {
  const { spec, speed, amount } = clampMotion(motion)
  return {
    // overlay's own W/H (frame) and w/h (the picture), as clipMotionAt.
    dx: spec.x ? `${spec.x.edges ? 'max(0,(W-w)/2)' : 'H'}*${waveExpr(spec.x, time, speed, amount)}` : null,
    dy: spec.y ? `${spec.y.edges ? 'max(0,(H-h)/2)' : 'H'}*${waveExpr(spec.y, time, speed, amount)}` : null,
    scale: spec.scale ? `(1+${waveExpr(spec.scale, time, speed, amount)})` : null,
    rotate: spec.rotate ? `(${waveExpr(spec.rotate, time, speed, amount)})*PI/180` : null
  }
}
