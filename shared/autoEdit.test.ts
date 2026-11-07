import { describe, expect, it } from 'vitest'
import { planAutoEdit } from './autoEdit'
import type { LearnedStyle, NarrationSegment, Shot } from './aiEditing'

const style = (over: Partial<LearnedStyle> = {}): LearnedStyle => ({ medianHold: 4, cutsPerMinute: 15, cutOnNarration: 1, commonSpeeds: [], ...over })
const scene = (start: number, end: number): Pick<Shot, 'start' | 'end' | 'duration'> => ({ start, end, duration: end - start })

describe('planAutoEdit', () => {
  const scenes = [scene(0, 30), scene(30, 60), scene(60, 90)]

  it('fills each narration line with clips at the learned hold', () => {
    const narration: NarrationSegment[] = [{ id: 'a', start: 0, end: 8, text: 'x' }] // 8s / 4s hold -> 2 clips
    const plan = planAutoEdit(style({ medianHold: 4 }), narration, scenes)
    expect(plan.clips).toHaveLength(2)
    expect(plan.clips[0].duration).toBe(4)
    expect(plan.clips[0].timelineStart).toBe(0)
    expect(plan.clips[1].timelineStart).toBe(4)
    expect(plan.usedHold).toBe(4)
  })

  it('never shows the same scene twice in a row', () => {
    const narration: NarrationSegment[] = [{ id: 'a', start: 0, end: 40, text: 'x' }]
    const plan = planAutoEdit(style({ medianHold: 4 }), narration, scenes)
    for (let i = 1; i < plan.clips.length; i += 1) {
      expect(plan.clips[i].sourceScene).not.toBe(plan.clips[i - 1].sourceScene)
    }
  })

  it('clips never run past the end of their source scene', () => {
    const narration: NarrationSegment[] = [{ id: 'a', start: 0, end: 10, text: 'x' }]
    const plan = planAutoEdit(style({ medianHold: 5 }), [...narration], [scene(0, 3), scene(3, 6)])
    for (const clip of plan.clips) {
      const s = clip.sourceScene === 0 ? scene(0, 3) : scene(3, 6)
      expect(clip.sourceOut).toBeLessThanOrEqual(s.end)
      expect(clip.sourceIn).toBeGreaterThanOrEqual(s.start)
    }
  })

  it('places lines back to back across the whole narration', () => {
    const narration: NarrationSegment[] = [
      { id: 'a', start: 0, end: 4, text: 'one' },
      { id: 'b', start: 4, end: 8, text: 'two' },
    ]
    const plan = planAutoEdit(style({ medianHold: 4 }), narration, scenes)
    expect(plan.clips.map((c) => c.narrationId)).toEqual(['a', 'b'])
    expect(plan.duration).toBe(8)
  })

  it('clamps an extreme learned hold', () => {
    const narration: NarrationSegment[] = [{ id: 'a', start: 0, end: 20, text: 'x' }]
    expect(planAutoEdit(style({ medianHold: 0.1 }), narration, scenes).usedHold).toBe(1.5)
    expect(planAutoEdit(style({ medianHold: 99 }), narration, scenes).usedHold).toBe(12)
  })

  it('is safe with no narration or no scenes', () => {
    expect(planAutoEdit(style(), [], scenes).clips).toHaveLength(0)
    expect(planAutoEdit(style(), [{ id: 'a', start: 0, end: 5, text: 'x' }], []).clips).toHaveLength(0)
  })
})
