import { describe, expect, it } from 'vitest'
import { TOGETHER_MAX_EXTRA, togetherDelaySeconds, togetherPartId } from './dubbingTogether'

describe('togetherDelaySeconds', () => {
  it("starts the line's own voice on time and every other one a little after, each at its own moment", () => {
    expect(togetherDelaySeconds(0)).toBe(0)
    const delays = Array.from({ length: TOGETHER_MAX_EXTRA }, (_, i) => togetherDelaySeconds(i + 1))
    expect(new Set(delays).size).toBe(TOGETHER_MAX_EXTRA)
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(0.15)
    }
  })
})

describe('togetherPartId', () => {
  it('gives every extra voice of a line an id of its own', () => {
    expect(togetherPartId('a', 1)).not.toBe(togetherPartId('a', 2))
    expect(togetherPartId('a', 1)).not.toBe('a')
  })
})
