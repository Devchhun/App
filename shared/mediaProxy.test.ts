import { describe, expect, it } from 'vitest'
import { needsPreviewProxy, type MediaMetadata } from './media'

const video = (over: Partial<MediaMetadata>): MediaMetadata => ({
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  videoPixelFormat: 'yuv420p',
  hasVideo: true,
  hasAudio: true,
  containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  fileSizeBytes: 1,
  ...over
})

describe('needsPreviewProxy', () => {
  it('plays an ordinary H.264 file as it is, as CapCut does', () => {
    expect(needsPreviewProxy(video({}))).toBe(false)
    // The 47-minute 2560x1440 60 fps export that sat at "48%".
    expect(needsPreviewProxy(video({ width: 2560, height: 1440, frameRate: 60 }))).toBe(false)
    expect(needsPreviewProxy(video({ width: 1080, height: 1920 }))).toBe(false)
    expect(needsPreviewProxy(video({ videoCodec: 'vp9', containerFormat: 'matroska,webm' }))).toBe(false)
  })

  it('keeps the proxy for what Chromium cannot play smoothly', () => {
    expect(needsPreviewProxy(video({ videoCodec: 'hevc' }))).toBe(true)
    expect(needsPreviewProxy(video({ videoCodec: 'prores' }))).toBe(true)
    expect(needsPreviewProxy(video({ videoPixelFormat: 'yuv420p10le' }))).toBe(true)
    expect(needsPreviewProxy(video({ width: 3840, height: 2160 }))).toBe(true)
    expect(needsPreviewProxy(video({ frameRate: 120 }))).toBe(true)
    expect(needsPreviewProxy(video({ containerFormat: 'matroska,webm' }))).toBe(true)
    expect(needsPreviewProxy(video({ width: undefined }))).toBe(true)
  })

  it('never for sound only', () => {
    expect(needsPreviewProxy(video({ hasVideo: false, videoCodec: undefined }))).toBe(false)
  })
})
