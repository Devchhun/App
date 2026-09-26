import { describe, expect, it } from 'vitest'
import { chunkForPasses, MAX_INPUTS_PER_PASS } from './audioStitch'

describe('chunkForPasses', () => {
  it('leaves a short list alone', () => {
    expect(chunkForPasses(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']])
    expect(chunkForPasses(Array.from({ length: MAX_INPUTS_PER_PASS }, (_, i) => i))).toHaveLength(1)
  })

  it('splits a long list into passes that each fit one ffmpeg command line', () => {
    const parts = Array.from({ length: 250 }, (_, i) => `part-${i}`)
    const groups = chunkForPasses(parts)
    expect(groups.length).toBe(Math.ceil(250 / MAX_INPUTS_PER_PASS))
    expect(groups.every((g) => g.length <= MAX_INPUTS_PER_PASS)).toBe(true)
    // Nothing lost, nothing reordered -- a recap is a continuous read.
    expect(groups.flat()).toEqual(parts)
  })

  it('folds down to a single pass in two rounds even for a very long script', () => {
    let current: unknown[] = Array.from({ length: 1000 }, (_, i) => i)
    let rounds = 0
    while (current.length > MAX_INPUTS_PER_PASS) {
      current = chunkForPasses(current).map((g) => g.length)
      rounds++
    }
    expect(rounds).toBe(1)
    expect(current.length).toBeLessThanOrEqual(MAX_INPUTS_PER_PASS)
  })
})
