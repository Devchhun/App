import { describe, expect, it } from 'vitest'
import { faceCandidates, groupGender, groupVoicePrints, voiceGenderScore, type VoicePrint } from './cast'
import { VOICE_GENDER_RULE } from './castGenderRule'

/** A repeatable stream of numbers in [-1, 1). */
function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2147483648 - 1
  }
}

/** `count` prints of one voice: `base` with a little of something else in. */
function voice(name: string, base: number[], count: number, seed: number, spread = 0.25, seconds = 2): VoicePrint[] {
  const next = noise(seed)
  return Array.from({ length: count }, (_, k) => {
    const v = base.map((x) => x + next() * spread)
    const norm = Math.hypot(...v)
    return { id: `${name}${k}`, embedding: v.map((x) => x / norm), seconds, f0: name === 'w' ? 240 : 120, voiced: 0.6 }
  })
}

const axis = (i: number, n = 24): number[] => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0))

describe('groupVoicePrints', () => {
  it('puts each voice in a group of its own, the most heard first', () => {
    const prints = [...voice('a', axis(0), 30, 1), ...voice('b', axis(1), 12, 2), ...voice('w', axis(2), 20, 3)]
    const groups = groupVoicePrints(prints, 0.45)
    expect(groups.map((g) => g.lineIds.length)).toEqual([30, 20, 12])
    expect(groups.map((g) => new Set(g.lineIds.map((id) => id[0])).size)).toEqual([1, 1, 1])
    expect(groups[0].unsureIds).toEqual([])
    expect(groups[0].sampleIds.length).toBeLessThanOrEqual(12)
    expect(groups[0].seconds).toBeCloseTo(60, 5)
  })

  it('keeps the order the lines were given in', () => {
    const a = voice('a', axis(0), 6, 4)
    const b = voice('b', axis(1), 6, 5)
    const mixed = a.flatMap((line, i) => [line, b[i]])
    const groups = groupVoicePrints(mixed, 0.45)
    expect(groups.find((g) => g.lineIds[0] === 'a0')?.lineIds).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5'])
  })

  it('never founds a group on short lines: they join the nearest voice', () => {
    const prints = [...voice('a', axis(0), 10, 6), ...voice('b', axis(1), 10, 7), ...voice('a', axis(0), 5, 8, 0.25, 0.4).map((p) => ({ ...p, id: `short-${p.id}` }))]
    const groups = groupVoicePrints(prints, 0.45)
    expect(groups).toHaveLength(2)
    expect(groups[0].lineIds.filter((id) => id.startsWith('short-'))).toHaveLength(5)
  })

  it('marks a line that is not much like its group as unsure', () => {
    // Half one voice, half the other: it has to go somewhere.
    const between = { id: 'between', embedding: axis(0).map((x, k) => (k < 2 ? Math.SQRT1_2 : x * 0)), seconds: 0.5 }
    const groups = groupVoicePrints([...voice('a', axis(0), 10, 9, 0.1), ...voice('b', axis(1), 10, 10, 0.1), between], 0.8)
    expect(groups.flatMap((g) => g.unsureIds)).toEqual(['between'])
  })

  it('takes one odd line into the voice it is nearest to, when nearly close enough', () => {
    const odd = { id: 'odd', embedding: [0.62, 0, 0.78, ...Array(21).fill(0)], seconds: 2 }
    const groups = groupVoicePrints([...voice('a', axis(0), 10, 11, 0.1), ...voice('b', axis(1), 10, 12, 0.1), odd], 0.65)
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.lineIds.includes('odd'))?.lineIds[0]).toBe('a0')
  })

  it('leaves a voice heard once on its own when nothing is like it', () => {
    const groups = groupVoicePrints([...voice('a', axis(0), 10, 13, 0.1), ...voice('b', axis(1), 10, 14, 0.1), { id: 'stranger', embedding: axis(5), seconds: 3 }], 0.5)
    expect(groups.map((g) => g.lineIds.length)).toEqual([10, 10, 1])
  })

  it('has nothing to say about no prints, and one group for a single voice', () => {
    expect(groupVoicePrints([], 0.4)).toEqual([])
    expect(groupVoicePrints(voice('a', axis(0), 4, 15), 0.4)).toHaveLength(1)
  })

  it('tells male from female by the voice print, not the pitch', () => {
    const { weights, offset } = VOICE_GENDER_RULE
    expect(weights).toHaveLength(192)
    // A print along the rule's direction is a man's, against it a woman's -- whatever the pitch says.
    const norm = Math.hypot(...weights)
    const man = weights.map((w) => (w / norm) * 0.5)
    const woman = weights.map((w) => (-w / norm) * 0.5)
    expect(voiceGenderScore([man])).toBeCloseTo(0.5 * norm + offset, 5)
    expect(groupGender({ f0Hz: 320, voicedRatio: 0.6, genderScore: voiceGenderScore([man, man]) }).gender).toBe('male')
    expect(groupGender({ f0Hz: 110, voicedRatio: 0.6, genderScore: voiceGenderScore([woman]) }).gender).toBe('female')
    // Too near the line to call.
    expect(groupGender({ f0Hz: 110, voicedRatio: 0.6, genderScore: 0.004 })).toEqual({ gender: 'unknown', confidence: 0 })
    // Prints of another size: no answer from the rule.
    expect(voiceGenderScore([[1, 0, 0]])).toBeUndefined()
    expect(voiceGenderScore([])).toBeUndefined()
  })

  it('falls back to the median pitch for prints the rule was not fitted on', () => {
    const groups = groupVoicePrints([...voice('a', axis(0), 10, 16), ...voice('w', axis(2), 10, 17)], 0.45)
    expect(groups.map((g) => groupGender(g).gender).sort()).toEqual(['female', 'male'])
  })
})

describe('faceCandidates', () => {
  const lines = new Map([
    ['a', { path: 'v', start: 10, end: 12 }],
    ['b', { path: 'v', start: 12.5, end: 14 }],
    ['c', { path: 'v', start: 60, end: 62 }],
    ['d', { path: 'v', start: 90, end: 90.3 }],
    ['e', { path: 'w', start: 11, end: 13 }]
  ])
  it('takes clear lines spread over the video, not two of one scene, and no very short ones', () => {
    expect(faceCandidates(['a', 'b', 'c', 'd', 'e'], lines)).toEqual(['a', 'c', 'e'])
  })
  it('still gives a voice with only short lines a picture', () => {
    expect(faceCandidates(['d'], lines)).toEqual(['d'])
  })
})
