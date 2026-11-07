import { describe, expect, it } from 'vitest'
import { buildSamples, learnStyle } from './editSamples'
import type { SegmentMatch, NarrationSegment } from './aiEditing'

function match(editedStart: number, editedEnd: number, opts: Partial<SegmentMatch> = {}): SegmentMatch {
  return {
    id: `${editedStart}-${editedEnd}`,
    editedStart,
    editedEnd,
    sourceStart: 0,
    sourceEnd: editedEnd - editedStart,
    confidence: 0.9,
    origin: 'auto',
    ...opts,
  }
}

describe('buildSamples', () => {
  it('groups matches under the narration line they play during', () => {
    const matches = [match(0, 2, { editedShot: 0 }), match(2, 3, { editedShot: 1 }), match(3, 6, { editedShot: 2 })]
    const narration: NarrationSegment[] = [
      { id: 'n1', start: 0, end: 3, text: 'line one' },
      { id: 'n2', start: 3, end: 6, text: 'line two' },
    ]
    const samples = buildSamples('p', matches, narration)
    expect(samples).toHaveLength(2)
    expect(samples[0].narration?.text).toBe('line one')
    expect(samples[0].cutCount).toBe(2) // two scenes shown over the first line
    expect(samples[0].editedDuration).toBe(3)
    expect(samples[1].cutCount).toBe(1)
  })

  it('without narration, makes one sample per edited shot', () => {
    const matches = [match(0, 2, { editedShot: 0 }), match(2, 5, { editedShot: 1 })]
    const samples = buildSamples('p', matches)
    expect(samples).toHaveLength(2)
    expect(samples.every((s) => s.narration === undefined)).toBe(true)
  })

  it('takes the lowest match confidence for a line', () => {
    const matches = [match(0, 1, { confidence: 0.9 }), match(1, 2, { confidence: 0.4 })]
    const narration: NarrationSegment[] = [{ id: 'n', start: 0, end: 2, text: 'x' }]
    expect(buildSamples('p', matches, narration)[0].confidence).toBe(0.4)
  })
})

describe('learnStyle', () => {
  it('derives pacing numbers from confident samples', () => {
    const matches = [
      match(0, 2, { editedShot: 0, confidence: 0.9 }),
      match(2, 4, { editedShot: 1, confidence: 0.9 }),
      match(4, 6, { editedShot: 2, confidence: 0.9 }),
    ]
    const narration: NarrationSegment[] = [{ id: 'n', start: 0, end: 6, text: 'x' }]
    const style = learnStyle(buildSamples('p', matches, narration))
    expect(style.medianHold).toBe(2)
    expect(style.cutsPerMinute).toBe(30) // 3 cuts over 6s -> 30/min
  })

  it('is safe on an empty dataset', () => {
    expect(learnStyle([])).toEqual({ medianHold: 0, cutsPerMinute: 0, cutOnNarration: 0, commonSpeeds: [] })
  })

  it('picks up common speed changes', () => {
    const matches = [
      match(0, 2, { editedShot: 0, transform: { speed: 2 } }),
      match(2, 4, { editedShot: 1, transform: { speed: 2 } }),
      match(4, 6, { editedShot: 2, transform: { speed: 1 } }),
    ]
    expect(learnStyle(buildSamples('p', matches)).commonSpeeds).toContain(2)
  })
})
