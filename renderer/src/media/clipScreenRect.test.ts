import { describe, expect, it } from 'vitest'
import type { TimelineClip } from '@shared/project'
import { clipMotionAt } from '@shared/clipMotion'
import { clipScreenRect, isOnClip } from './clipScreenRect'

const logo = (patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id: 'logo', mediaId: 'm', type: 'image', trackId: 'V2', startTime: 0, duration: 60, sourceIn: 0, sourceOut: 60, locked: false,
  transform: { x: 100, y: -50, scaleX: 0.2, scaleY: 0.2, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
  ...patch
})
const stage = { width: 400, height: 400 }
const media = { width: 500, height: 500 }

describe('clipScreenRect', () => {
  it('puts a still picture where it was placed, its size fitted and scaled', () => {
    const r = clipScreenRect(logo(), stage, media, 'contain', 5)!
    expect(r.w).toBeCloseTo(80, 6)
    expect(r.h).toBeCloseTo(80, 6)
    expect(isOnClip(r, r.cx, r.cy)).toBe(true)
    expect(isOnClip(r, r.cx + 41, r.cy)).toBe(false)
  })

  it('follows its motion: the frame is where the moving logo is now', () => {
    const motion = { preset: 'around' as const, speed: 1, amount: 0.95 }
    const still = clipScreenRect(logo(), stage, media, 'contain', 3)!
    const moving = clipScreenRect(logo({ motion }), stage, media, 'contain', 3)!
    const m = clipMotionAt(motion, 3, stage, { width: 80, height: 80 })
    expect(moving.cx - still.cx).toBeCloseTo(m.dx, 6)
    expect(moving.cy - still.cy).toBeCloseTo(m.dy, 6)
    // A click on the logo where it is now picks it; where it rests does not.
    expect(isOnClip(moving, moving.cx, moving.cy)).toBe(true)
    expect(isOnClip(moving, still.cx, still.cy)).toBe(Math.abs(m.dx) < 40 && Math.abs(m.dy) < 40)
  })

  it('knows a turned picture', () => {
    const r = clipScreenRect(logo({ transform: { x: 0, y: 0, scaleX: 0.4, scaleY: 0.1, rotation: 90, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 } }), stage, media, 'contain', 0)!
    // 160 wide, 40 tall, turned upright: 40 wide, 160 tall on screen.
    expect(isOnClip(r, r.cx, r.cy + 70)).toBe(true)
    expect(isOnClip(r, r.cx + 70, r.cy)).toBe(false)
  })
})
