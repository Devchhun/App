import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))

const { ffmpegFailureMessage } = await import('./jobRunner')

describe('ffmpegFailureMessage', () => {
  it('names the problem, not the encoder statistics printed on the way out', () => {
    // The tail of a real failed export (the problem lines came long before).
    const stderr = [
      '[libx264 @ 000001] i8c dc,h,v,p: 69% 13% 15%  3%',
      '[libx264 @ 000001] Weighted P-Frames: Y:27.3% UV:27.3%',
      '[libx264 @ 000001] kb/s:767.65',
      '[aac @ 000002] Qavg: 2168.576',
      'Conversion failed!'
    ].join('\n')
    const problems = [
      '[aac @ 000002] Queue input is backward in time',
      '[mp4 @ 000003] Application provided invalid, non monotonically increasing dts to muxer in stream 1',
      '[out#0/mp4 @ 000004] Error muxing a packet'
    ]
    const message = ffmpegFailureMessage(problems, stderr, 1)
    expect(message).toContain('Queue input is backward in time')
    expect(message).toContain('Error muxing a packet')
    expect(message).toContain('Conversion failed!')
    expect(message).not.toContain('Qavg')
    expect(message).not.toContain('kb/s')
  })

  it('falls back to the exit code when ffmpeg said nothing', () => {
    expect(ffmpegFailureMessage([], '', 3)).toBe('ffmpeg exited with code 3')
  })
})
