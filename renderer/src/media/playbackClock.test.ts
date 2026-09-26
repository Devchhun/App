import { describe, expect, it } from 'vitest'
import { isVideoReady, MAX_HOLD_MS, nextPlayheadTime } from './playbackClock'

const base = { previousTime: 10, wallDeltaSeconds: 0.016, stalledMs: 0 }

describe('nextPlayheadTime', () => {
  it('follows the video while it plays, so there is nothing to chase', () => {
    expect(nextPlayheadTime({ ...base, videoTime: 10.033, videoReady: true })).toEqual({ time: 10.033, source: 'video' })
  })

  it('never steps backwards when the decoder reports a hair early', () => {
    expect(nextPlayheadTime({ ...base, videoTime: 9.99, videoReady: true })).toEqual({ time: 10, source: 'video' })
  })

  it('waits for a video that is starting, seeking or buffering', () => {
    expect(nextPlayheadTime({ ...base, videoTime: 10, videoReady: false, stalledMs: 400 })).toEqual({ time: 10, source: 'hold' })
  })

  it('falls back to the wall clock when the video never delivers, so the Timeline cannot freeze', () => {
    expect(nextPlayheadTime({ ...base, videoTime: 10, videoReady: false, stalledMs: MAX_HOLD_MS })).toEqual({ time: 10.016, source: 'wall' })
  })

  it('uses the wall clock where no video is on screen', () => {
    expect(nextPlayheadTime({ ...base, videoTime: null, videoReady: false })).toEqual({ time: 10.016, source: 'wall' })
  })
})

describe('isVideoReady', () => {
  it('is ready only while playing, not seeking, with data buffered ahead', () => {
    expect(isVideoReady({ paused: false, seeking: false, readyState: 4 })).toBe(true)
    expect(isVideoReady({ paused: false, seeking: false, readyState: 3 })).toBe(true)
    expect(isVideoReady({ paused: false, seeking: false, readyState: 2 })).toBe(false)
    expect(isVideoReady({ paused: false, seeking: true, readyState: 4 })).toBe(false)
    expect(isVideoReady({ paused: true, seeking: false, readyState: 4 })).toBe(false)
  })
})
