import { describe, expect, it } from 'vitest'
import { CLIP_MOTION_PRESETS, clipMotionAt, clipMotionExprs, type ClipMotion } from './clipMotion'

/** Evaluates one of the ffmpeg expressions in JS: the same functions, the
 * frame's W/H, and `t`. */
function evalExpr(expr: string, vars: { t: number; W: number; H: number; w?: number; h?: number }): number {
  const js = expr.replace(/\bPI\b/g, 'Math.PI').replace(/\b(sin|abs|floor|max)\(/g, 'Math.$1(').replace(/\bclip\(/g, 'clip(')
  const clip = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
  return new Function('clip', 't', 'W', 'H', 'w', 'h', `return ${js}`)(clip, vars.t, vars.W, vars.H, vars.w ?? 0, vars.h ?? 0) as number
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

  it('runs up and down, left and right, and around the screen edge to edge, never leaving it', () => {
    const picture = { width: 300, height: 180 }
    const roomX = (frame.width - picture.width) / 2
    const roomY = (frame.height - picture.height) / 2
    // Up & Down / Left & Right start where the clip was put.
    expect(clipMotionAt({ preset: 'updown', speed: 1, amount: 1 }, 0, frame, picture).dy).toBeCloseTo(0, 6)
    expect(clipMotionAt({ preset: 'leftright', speed: 1, amount: 1 }, 0, frame, picture).dx).toBeCloseTo(0, 6)
    const reach = (preset: ClipMotion['preset']): { x: number; y: number } => {
      let x = 0
      let y = 0
      for (let t = 0; t < 24; t += 0.05) {
        const at = clipMotionAt({ preset, speed: 1, amount: 1 }, t, frame, picture)
        expect(Math.abs(at.dx)).toBeLessThanOrEqual(roomX + 1e-6)
        expect(Math.abs(at.dy)).toBeLessThanOrEqual(roomY + 1e-6)
        x = Math.max(x, Math.abs(at.dx))
        y = Math.max(y, Math.abs(at.dy))
      }
      return { x, y }
    }
    expect(reach('updown')).toEqual({ x: 0, y: expect.closeTo(roomY, 0) })
    expect(reach('leftright')).toEqual({ x: expect.closeTo(roomX, 0), y: 0 })
    expect(reach('around')).toEqual({ x: expect.closeTo(roomX, 0), y: expect.closeTo(roomY, 0) })
    // Around keeps to the edges: at every moment it is on one of them.
    for (let t = 0; t < 12; t += 0.1) {
      const at = clipMotionAt({ preset: 'around', speed: 1, amount: 1 }, t, frame, picture)
      expect(Math.abs(Math.abs(at.dx) - roomX) < 1e-6 || Math.abs(Math.abs(at.dy) - roomY) < 1e-6).toBe(true)
    }
  })

  it('keeps on from where an earlier piece of a long export stopped', () => {
    const motion: ClipMotion = { preset: 'circle', speed: 1, amount: 0.5 }
    const exprs = clipMotionExprs(motion, 't+12.5')
    expect(evalExpr(exprs.dx!, { t: 0.5, W: 1920, H: 1080 })).toBeCloseTo(clipMotionAt(motion, 13, frame).dx, 4)
  })
})
