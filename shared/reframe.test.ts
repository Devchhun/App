import { describe, expect, it } from 'vitest'
import { interpolateKeyframes, keyframesExpr, type ClipKeyframe } from './keyframes'
import { planReframe, reframeCentreAt, reframeClip, reframeWindow, type ReframeSample } from './reframe'
import { buildExportFilterGraph, DEFAULT_EXPORT_OPTIONS } from './export'
import type { TimelineClip } from './project'

function evalExpr(expr: string, t: number): number {
  const js = expr
    .replace(/\bif\(/g, 'iff(')
    .replace(/\blt\(/g, 'lt(')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('t', 'iff', 'lt', 'clip', 'pow', `return ${js}`)(
    t,
    (c: number, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a < b ? 1 : 0),
    (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
    Math.pow
  ) as number
}

describe('keyframesExpr', () => {
  it('gives Export the same position as the Player, every easing', () => {
    const kf: ClipKeyframe[] = [
      { id: 'a', time: 0.5, value: -100 },
      { id: 'b', time: 1.5, value: 40, easing: 'ease-in' },
      { id: 'c', time: 2.5, value: 40, easing: 'ease-out' },
      { id: 'd', time: 2.52, value: 300, easing: 'linear' },
      { id: 'e', time: 4, value: -20, easing: 'ease-in-out' }
    ]
    const expr = keyframesExpr(kf, 't', 0)
    for (let t = 0; t <= 5; t += 0.07) expect(evalExpr(expr, t)).toBeCloseTo(interpolateKeyframes(kf, t, 0), 4)
    expect(keyframesExpr(undefined, 't', 12)).toBe('12')
    expect(keyframesExpr([{ id: 'x', time: 1, value: 7 }], 't', 0)).toBe('7')
  })
})

describe('Auto Reframe', () => {
  const sample = (t: number, ...faces: [number, number, number, number][]): ReframeSample => ({ t, faces })

  it('knows which way the frame cuts into the picture', () => {
    expect(reframeWindow(16 / 9, 9 / 16)).toEqual({ axis: 'x', window: (9 / 16) / (16 / 9) })
    expect(reframeWindow(9 / 16, 16 / 9)?.axis).toBe('y')
    expect(reframeWindow(16 / 9, 16 / 9)).toBeNull()
  })

  it('follows the face, holds through moments with nobody, never leaves the picture', () => {
    const samples: ReframeSample[] = []
    for (let i = 0; i < 20; i++) samples.push(sample(i * 0.5, ...(i === 7 ? [] : [[0.2 + i * 0.01, 0.4, 0.1, 1] as [number, number, number, number]])))
    const plan = planReframe(samples, 16 / 9, 9 / 16)!
    expect(plan.axis).toBe('x')
    const half = plan.window / 2
    for (let t = 0; t < 10; t += 0.25) {
      const c = reframeCentreAt(plan, t)
      expect(c).toBeGreaterThanOrEqual(half - 1e-9)
      expect(c).toBeLessThanOrEqual(1 - half + 1e-9)
    }
    // The face sits at 0.2-0.39: the frame stays on it (as far left as it can go).
    expect(Math.abs(reframeCentreAt(plan, 5) - Math.max(half, 0.27))).toBeLessThan(0.08)
  })

  it('cuts with the video instead of panning across the cut', () => {
    const samples = [0, 0.5, 1, 1.5, 2].map((t) => sample(t, [0.2, 0.4, 0.1, 1])).concat([2.5, 3, 3.5, 4].map((t) => sample(t, [0.8, 0.4, 0.1, 1])))
    const plan = planReframe(samples, 16 / 9, 9 / 16)!
    expect(reframeCentreAt(plan, 2)).toBeLessThan(0.4)
    expect(reframeCentreAt(plan, 2.5)).toBeGreaterThan(0.6)
  })

  it('turns the plan into Fill scale and Position keyframes on the clip', () => {
    const plan = { axis: 'x' as const, window: 0.3164, points: [{ t: 10, c: 0.2 }, { t: 12, c: 0.8 }] }
    let n = 0
    const out = reframeClip(plan, { sourceIn: 10, sourceOut: 12, duration: 2 }, 9 / 16, false, () => `k${n++}`)
    expect(out.scale).toBeCloseTo(1 / 0.3164, 6)
    expect(out.property).toBe('x')
    // 1080 wide frame, picture 3413 wide: centre 0.2 -> +1024 (clamped to the room, 1166).
    expect(out.keyframes[0].value).toBeCloseTo(0.3 * 1080 / 0.3164, 0)
    expect(out.keyframes[out.keyframes.length - 1].value).toBeCloseTo(-0.3 * 1080 / 0.3164, 0)
    // Mirrored: the other way.
    const mirrored = reframeClip(plan, { sourceIn: 10, sourceOut: 12, duration: 2 }, 9 / 16, true, () => 'm')
    expect(mirrored.keyframes[0].value).toBeCloseTo(-out.keyframes[0].value, 6)
  })

  it('moves the picture in Export with the keyframes', () => {
    const clip: TimelineClip = { id: 'v', mediaId: 'm', type: 'video', trackId: 'V1', startTime: 0, duration: 2, sourceIn: 0, sourceOut: 2, locked: false, transform: { x: 0, y: 0, scaleX: 3, scaleY: 3, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }, keyframes: { x: [{ id: 'a', time: 0, value: 500 }, { id: 'b', time: 2, value: -500 }] } }
    const { args } = buildExportFilterGraph([{ clip, sourcePath: 'f.mp4', trackOrder: 0 }], [], 2, { width: 1080, height: 1920 }, 30, { ...DEFAULT_EXPORT_OPTIONS, includeAudio: false }, 'o.mp4')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toMatch(/overlay=x='\(W-w\)\/2\+\(if\(lt\(/)
  })
})
