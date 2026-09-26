import { describe, it, expect } from 'vitest'
import { timingStatus } from './narrationTiming'

describe('timingStatus (Recording Assistant timing feedback)', () => {
  it('shows a placeholder before anything has been recorded', () => {
    expect(timingStatus(5, 0)).toEqual({ label: '—', className: '' })
  })

  it('reports good timing when the recording closely matches the target', () => {
    const result = timingStatus(5, 5.1)
    expect(result.className).toBe('narration-timing-good')
  })

  it('flags exceeding the subtitle range, with the exact overage amount', () => {
    const result = timingStatus(5, 7)
    expect(result.className).toBe('narration-timing-bad')
    expect(result.label).toContain('2.0s')
  })

  it('flags a take that is too short relative to a real (>1s) target', () => {
    const result = timingStatus(10, 2)
    expect(result.className).toBe('narration-timing-warn')
    expect(result.label).toBe('Too short')
  })

  it('never alters the recorded duration itself -- purely descriptive', () => {
    // Same recordedSeconds in, same value implied by the label's math out --
    // this function must never round-trip a "corrected" duration.
    const result = timingStatus(3, 6)
    expect(result.label).toBe('Exceeds subtitle range by 3.0s')
  })
})
