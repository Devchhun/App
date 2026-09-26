import { describe, expect, it } from 'vitest'
import { computeTimelineDisplayDuration } from './timelineDuration'

describe('computeTimelineDisplayDuration', () => {
  it('keeps caption blocks visible when they extend beyond the last media clip', () => {
    expect(computeTimelineDisplayDuration(260.69, [], [119.36, 1337.4])).toBe(1342.4)
  })

  it('keeps the sequence duration when clips extend furthest', () => {
    expect(computeTimelineDisplayDuration(900, [300], [600])).toBe(900)
  })
})
