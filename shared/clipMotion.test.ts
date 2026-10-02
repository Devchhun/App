import { describe, expect, it } from 'vitest'
import { CLIP_MOTION_PRESETS, clipMotionAt, clipMotionExprs, type ClipMotion } from './clipMotion'

/** Evaluates one of the ffmpeg expressions in JS: the same functions, the
 * frame's W/H, and `t`. */
function evalExpr(expr: string, vars: { t: number; W: number; H: number; w?: number; h?: number }): number {
  const js = expr.replace(/\bPI\b/g, 'Math.PI').replace(/\b(sin|abs|floor|max)\(/g, 'Math.$1(')
  return new Function('t', 'W', 'H', 'w', 'h', `return ${js}`)(vars.t, vars.W, vars.H, vars.w ?? 0, vars.h ?? 0) as number
}

describe('clip motion', () => {
  const frame = { width: 1920, height: 1080 }
  it('moves the Player and the export the same way, for every preset', () => {
    for (const preset of CLIP_MOTION_PRESETS) {
      const motion: ClipMotion = { preset, speed: 1.3, amount: 0.7 }
      const exprs = clipMotionExprs(motion, 't')
      const picture = { width: 300, height: 180 }
      for (const t of [0, 0.37, 1.1, 2.5, 6.9]) {
        const at = clipMotionAt(motion, t, frame, picture)
        const vars = { t, W: frame.width, H: frame.height, w: picture.width, h: picture.height }
        expect(exprs.dx ? evalExpr(exprs.dx, vars) : 0).toBeCloseTo(at.dx, 2)
        expect(exprs.dy ? evalExpr(exprs.dy, vars) : 0).toBeCloseTo(at.dy, 2)
        expect(exprs.scale ? evalExpr(exprs.scale, vars) : 1).toBeCloseTo(at.scale, 6)
        expect(exprs.rotate ? evalExpr(exprs.rotate, vars) : 0).toBeCloseTo((at.rotate * Math.PI) / 180, 6)
      }
    }
  })

  it('starts where a still clip would be, and Wander stays inside the frame', () => {
    expect(clipMotionAt({ preset: 'float', speed: 1, amount: 0.6 }, 0, frame)).toEqual({ dx: 0, dy: -0, scale: 1, rotate: 0 })
    // Wander runs edge to edge: the picture never leaves the frame.
    const picture = { width: 300, height: 180 }
    let reachedX = 0
    for (let t = 0; t < 30; t += 0.05) {
      const at = clipMotionAt({ preset: 'wander', speed: 1, amount: 1 }, t, frame, picture)
      expect(Math.abs(at.dx)).toBeLessThanOrEqual((frame.width - picture.width) / 2 + 1e-6)
      expect(Math.abs(at.dy)).toBeLessThanOrEqual((frame.height - picture.height) / 2 + 1e-6)
      reachedX = Math.max(reachedX, Math.abs(at.dx))
    }
    expect(reachedX).toBeGreaterThan((frame.width - picture.width) / 2 - 20)
  })

  it('keeps on from where an earlier piece of a long export stopped', () => {
    const motion: ClipMotion = { preset: 'circle', speed: 1, amount: 0.5 }
    const exprs = clipMotionExprs(motion, 't+12.5')
    expect(evalExpr(exprs.dx!, { t: 0.5, W: 1920, H: 1080 })).toBeCloseTo(clipMotionAt(motion, 13, frame).dx, 4)
  })
})
