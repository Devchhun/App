import { describe, expect, it } from 'vitest'
import type { ProjectSequence, TimelineClip } from '@shared/project'
import type { TranscriptSegment } from '@shared/transcription'
import { applyVideoSync, mapVideoSyncTime, planVideoSync, retimeSegmentsForVideoSync, videoSyncAddedSeconds, VIDEO_SYNC_MIN_RATE } from './videoSync'

const clip = (id: string, patch: Partial<TimelineClip>): TimelineClip => ({
  id, mediaId: `m-${id}`, type: 'video', trackId: 'V1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false, ...patch
})
const seq = (clips: TimelineClip[]): ProjectSequence => ({ tracks: [], clips, markers: [], duration: 0 })
let n = 0
const makeId = (): string => `id${++n}`

describe('planVideoSync', () => {
  it('slows only the room of a line whose dub is too long, just enough to fit', () => {
    const regions = planVideoSync([
      { start: 0, room: 2, clipSeconds: 1.5, videoRate: 1 },
      { start: 2, room: 2, clipSeconds: 2.25, videoRate: 1 }
    ])
    expect(regions).toEqual([{ start: 2, end: 4, rate: 0.870 }])
  })

  it('never slower than the minimum -- a much longer line still runs late', () => {
    expect(planVideoSync([{ start: 0, room: 1, clipSeconds: 3, videoRate: 1 }])[0].rate).toBe(VIDEO_SYNC_MIN_RATE)
  })

  it('counts a slow-down already applied (a second press does not drag further)', () => {
    expect(planVideoSync([{ start: 0, room: 1, clipSeconds: 3, videoRate: VIDEO_SYNC_MIN_RATE }])).toEqual([])
    expect(planVideoSync([{ start: 0, room: 1, clipSeconds: 3, videoRate: 0.9 }])[0].rate).toBeCloseTo(0.944, 3)
  })
})

describe('mapVideoSyncTime', () => {
  const regions = [{ start: 2, end: 4, rate: 0.8 }, { start: 6, end: 7, rate: 0.5 }]
  it('before, inside and after the slowed stretches', () => {
    expect(mapVideoSyncTime(regions, 1)).toBe(1)
    expect(mapVideoSyncTime(regions, 2)).toBe(2)
    expect(mapVideoSyncTime(regions, 3)).toBeCloseTo(3.25)
    expect(mapVideoSyncTime(regions, 4)).toBeCloseTo(4.5)
    expect(mapVideoSyncTime(regions, 6.5)).toBeCloseTo(7.5)
    expect(mapVideoSyncTime(regions, 10)).toBeCloseTo(11.5)
    expect(videoSyncAddedSeconds(regions)).toBeCloseTo(1.5)
  })
})

describe('applyVideoSync', () => {
  const regions = [{ start: 2, end: 4, rate: 0.8 }]
  const isPicture = (c: TimelineClip): boolean => c.trackId !== 'DUB1'

  it('cuts the picture and its linked sound at the region, slows the middle, moves the rest', () => {
    const video = clip('v', { linkedClipId: 'a' })
    const audio = clip('a', { type: 'audio', trackId: 'A1', linkedClipId: 'v' })
    const out = applyVideoSync(seq([video, audio]), regions, isPicture, makeId)
    const pieces = out.clips.filter((c) => c.trackId === 'V1').sort((x, y) => x.startTime - y.startTime)
    expect(pieces.map((c) => [c.startTime, +c.duration.toFixed(3), c.playbackRate ?? 1])).toEqual([[0, 2, 1], [2, 2.5, 0.8], [4.5, 6, 1]])
    // Same source window: nothing of the video is lost.
    expect(pieces.map((c) => [c.sourceIn, c.sourceOut])).toEqual([[0, 2], [2, 4], [4, 10]])
    const sound = out.clips.filter((c) => c.trackId === 'A1').sort((x, y) => x.startTime - y.startTime)
    expect(sound.map((c) => c.playbackRate ?? 1)).toEqual([1, 0.8, 1])
    for (const piece of pieces) expect(out.clips.find((c) => c.id === piece.linkedClipId)?.startTime).toBe(piece.startTime)
  })

  it('dubbed lines keep their length and move with the time around them', () => {
    const video = clip('v', {})
    const own = clip('d1', { type: 'audio', trackId: 'DUB1', startTime: 2, duration: 2.4 })
    const later = clip('d2', { type: 'audio', trackId: 'DUB1', startTime: 4, duration: 1 })
    const out = applyVideoSync(seq([video, own, later]), regions, isPicture, makeId)
    expect(out.clips.find((c) => c.id === 'd1')).toMatchObject({ startTime: 2, duration: 2.4 })
    expect(out.clips.find((c) => c.id === 'd2')!.startTime).toBeCloseTo(4.5)
    expect(out.duration).toBeGreaterThan(10.5)
  })

  it('leaves locked clips alone and does nothing without regions', () => {
    const locked = clip('v', { locked: true })
    const s = seq([locked])
    expect(applyVideoSync(s, [], isPicture, makeId)).toBe(s)
    expect(applyVideoSync(s, regions, isPicture, makeId).clips).toEqual([locked])
  })
})

describe('retimeSegmentsForVideoSync', () => {
  it('moves subtitles with the picture', () => {
    const seg = (id: string, startTime: number, endTime: number): TranscriptSegment => ({ id, startTime, endTime, text: id, words: [{ text: id, startTime, endTime, confidence: 1 }], language: 'zh', confidence: 1, needsReview: false })
    const out = retimeSegmentsForVideoSync([seg('a', 0, 1.5), seg('b', 2, 3.5), seg('c', 4, 5)], [{ start: 2, end: 4, rate: 0.8 }])
    expect(out.map((s) => [s.startTime, +s.endTime.toFixed(3)])).toEqual([[0, 1.5], [2, 3.875], [4.5, 5.5]])
    expect(out[2].words[0].startTime).toBeCloseTo(4.5)
  })
})

describe('applyVideoSync edge cases', () => {
  it('a clip ending a float hair past an edge is not cut into a zero-length piece', () => {
    const a = clip('a', { startTime: 0, duration: 2.412 + 9.8, sourceOut: 12.212 })
    const out = applyVideoSync(seq([a]), [{ start: 12.212, end: 13, rate: 0.85 }], () => true, makeId)
    expect(out.clips.every((c) => c.duration > 0.01)).toBe(true)
  })
})
