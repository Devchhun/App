import { describe, expect, it } from 'vitest'
import { createEmptySequence, type ProjectSequence, type TimelineClip } from './project'
import type { DetectedSpeakerProfile, TranscriptSegment } from './transcription'
import { batchPartsOf, findGaps, lineSource, mergeGapLines, mergePartSegments, partLocalSegments, placePartTranscript, pairSrtsWithVideos } from './dubbingBatch'

const seg = (id: string, startTime: number, endTime: number, speakerId?: string): TranscriptSegment => ({ id, words: [], startTime, endTime, language: 'km', confidence: 0.9, text: id, needsReview: false, speakerId })

function sequenceWith(clips: Partial<TimelineClip>[]): ProjectSequence {
  const base = createEmptySequence()
  const main = base.tracks.find((t) => t.isMain && t.kind === 'video')!
  return {
    ...base,
    clips: clips.map((c, i) => ({ id: `c${i}`, mediaId: `m${i}`, trackId: main.id, type: 'video', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, ...c }) as TimelineClip)
  }
}

describe('batch Auto SRT', () => {
  it('works through the main-track videos in Timeline order', () => {
    const parts = batchPartsOf(sequenceWith([{ startTime: 20 }, { startTime: 0 }, { startTime: 10 }]))
    expect(parts.map((p) => p.clipId)).toEqual(['c1', 'c2', 'c0'])
    expect(parts[2]).toMatchObject({ startTime: 20, endTime: 30 })
  })

  it("puts a video's subtitles on the Timeline under its clip", () => {
    const [part] = batchPartsOf(sequenceWith([{ startTime: 100, duration: 50, sourceIn: 0 }]))
    const { segments } = placePartTranscript(part, 'EP2', [seg('a', 1, 3), seg('b', 40, 44)], [])
    expect(segments.map((s) => [s.startTime, s.endTime])).toEqual([[101, 103], [140, 144]])
    expect(new Set(segments.map((s) => s.id)).size).toBe(2)
  })

  it('keeps only what a trimmed clip shows, and follows its speed', () => {
    const [part] = batchPartsOf(sequenceWith([{ startTime: 10, duration: 5, sourceIn: 20, playbackRate: 2 }]))
    // The clip shows file seconds 20..30 at 2x over Timeline 10..15.
    const { segments } = placePartTranscript(part, 'EP1', [seg('before', 5, 8), seg('in', 22, 26), seg('after', 31, 33)], [])
    expect(segments.map((s) => [s.text, s.startTime, s.endTime])).toEqual([['in', 11, 13]])
  })

  it('keeps each episode’s speakers apart and names them by episode', () => {
    const [part] = batchPartsOf(sequenceWith([{ startTime: 0 }]))
    const speaker = { id: 'speaker-1', name: 'Speaker 1', segmentIds: ['a'] } as DetectedSpeakerProfile
    const { segments, speakers } = placePartTranscript(part, 'EP3', [seg('a', 1, 2, 'speaker-1')], [speaker])
    expect(segments[0].speakerId).toBe('c0:speaker-1')
    expect(speakers[0]).toMatchObject({ id: 'c0:speaker-1', name: 'EP3 · Speaker 1', segmentIds: [segments[0].id] })
  })

  it("replaces only the lines under that clip, and gives them back in the video's own time", () => {
    const parts = batchPartsOf(sequenceWith([{ startTime: 0 }, { startTime: 10 }]))
    const existing = [seg('x', 1, 2), seg('old', 12, 13)]
    const merged = mergePartSegments(existing, parts[1], [seg('new', 11, 12)])
    expect(merged.map((s) => s.id)).toEqual(['x', 'new'])
    expect(partLocalSegments(merged, parts[1]).map((s) => [s.id, s.startTime])).toEqual([['new', 1]])
  })

  it('finds the video a Timeline line comes from, and its time in that file', () => {
    const parts = batchPartsOf(sequenceWith([{ startTime: 0, duration: 20 }, { startTime: 20, duration: 20, sourceIn: 5 }]))
    expect(lineSource(parts, 3, 5)).toEqual({ mediaId: 'm0', start: 3, end: 5 })
    expect(lineSource(parts, 21, 23)).toEqual({ mediaId: 'm1', start: 6, end: 8 })
    expect(lineSource(parts, 50, 52)).toBeNull()
  })

  it('finds the stretches with no lines -- start, middle and end of a video', () => {
    const [, second] = batchPartsOf(sequenceWith([{ startTime: 0, duration: 100 }, { startTime: 100, duration: 120, sourceIn: 10 }]))
    const lines = [seg('a', 105, 108), seg('b', 110, 112), seg('c', 150, 152)]
    expect(findGaps(second, lines).map((g) => [g.timelineStart, g.timelineEnd, g.fileStart, g.fileEnd])).toEqual([
      [112, 150, 22, 60],
      [152, 220, 62, 130]
    ])
  })

  it('adds the lines found in the gaps and leaves every existing line alone', () => {
    const gaps = [{ timelineStart: 10, timelineEnd: 40, fileStart: 10, fileEnd: 40 }]
    const merged = mergeGapLines([seg('keep', 5, 6), seg('keep2', 45, 46)], gaps, [seg('new', 20, 22), seg('dup', 5, 6)])
    expect(merged.map((s) => s.id)).toEqual(['keep', 'new', 'keep2'])
  })
})

describe('pairSrtsWithVideos', () => {
  it('pairs by the same name, ignoring a language tag', () => {
    expect(pairSrtsWithVideos(['EP02.mp4', 'EP01.mp4'], ['EP01.km.srt', 'EP02.srt'])).toEqual([1, 0])
  })
  it('pairs by episode number when the names differ', () => {
    expect(pairSrtsWithVideos(['Drama Ep 1.mp4', 'Drama Ep 2.mp4', 'Drama Ep 10.mp4'], ['10.srt', '第2集.srt', 'sub_1.srt'])).toEqual([2, 1, 0])
  })
  it('falls back to name order, one SRT per video', () => {
    expect(pairSrtsWithVideos(['b.mp4', 'a.mp4'], ['x.srt', 'y.srt', 'z.srt'])).toEqual([1, 0, null])
  })
})
