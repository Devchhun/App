import { describe, it, expect } from 'vitest'
import { planSceneRipple, applySceneRipple } from './sceneCollision'
import type { Scene } from '@shared/project'

function scene(id: string, track: string, startTime: number, endTime: number, locked = false): Scene {
  return {
    id,
    mediaId: 'm',
    segmentId: '',
    suggestionId: id,
    track,
    templateId: 'lower-third',
    startTime,
    endTime,
    purpose: 'main_claim',
    originalText: '',
    visualText: id,
    reason: '',
    confidence: 1,
    locked,
    edited: false,
    status: 'accepted',
    createdAt: ''
  } as Scene
}

describe('planSceneRipple', () => {
  it('fits when the span is clear', () => {
    const plan = planSceneRipple([scene('a', 'V2', 0, 3)], 'V2', 5, 8)
    expect(plan.fits).toBe(true)
  })

  it('pushes the scene it lands on, and the chain after it, right', () => {
    const scenes = [scene('a', 'V2', 2, 5), scene('b', 'V2', 5, 7), scene('c', 'V2', 20, 22)]
    const plan = planSceneRipple(scenes, 'V2', 1, 4)
    expect(plan.fits).toBe(false)
    expect(plan.pushes.get('a')).toEqual({ startTime: 4, endTime: 7 })
    expect(plan.pushes.get('b')).toEqual({ startTime: 7, endTime: 9 })
    expect(plan.pushes.has('c')).toBe(false)
    const out = applySceneRipple(scenes, plan)
    expect(out.find((s) => s.id === 'a')!.startTime).toBe(4)
    expect(out.find((s) => s.id === 'c')!.startTime).toBe(20)
  })

  it('ignores the moving scene itself and other tracks', () => {
    const scenes = [scene('me', 'V2', 1, 4), scene('other', 'V3', 1, 4)]
    expect(planSceneRipple(scenes, 'V2', 1, 4, 'me').fits).toBe(true)
  })

  it('routes around a locked scene instead of pushing it', () => {
    // The locked scene is an immovable obstacle: the cursor jumps past it,
    // so a scene right after it that already clears the obstacle is left
    // alone, while one that would collide is pushed past the obstacle.
    const scenes = [scene('lock', 'V2', 2, 6, true), scene('b', 'V2', 5, 8)]
    const plan = planSceneRipple(scenes, 'V2', 1, 4)
    expect(plan.pushes.has('lock')).toBe(false)
    expect(plan.pushes.get('b')).toEqual({ startTime: 6, endTime: 9 })
  })
})
