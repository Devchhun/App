import { describe, expect, it } from 'vitest'
import type { TimelineClip } from '@shared/project'
import type { TranscriptSegment } from '@shared/transcription'
import type { StoryOutline } from '@shared/videoStoryNarration'
import { clipSourceRange, outlineToTimeline, segmentsToSource, sourceSegmentsToTimeline } from './recapClipTime'

const seg = (id: string, startTime: number, endTime: number): TranscriptSegment => ({ id, startTime, endTime, text: id, words: [{ text: id, startTime, endTime, confidence: 1 }], language: 'zh', confidence: 1, needsReview: false })

// The user's case: a 1534.56 s episode whose 118 s opening teaser was trimmed
// off, the clip then sitting at the start of the Timeline.
const trimmed = { id: 'c', mediaId: 'm', type: 'video', trackId: 'V1', startTime: 0, duration: 1416.56, sourceIn: 118, sourceOut: 1534.56 } as TimelineClip

describe('recap clip time', () => {
  it('outlines only the part of the source the clip shows', () => {
    expect(clipSourceRange(trimmed, 1534.56)).toEqual({ start: 118, end: 1534.56 })
    expect(clipSourceRange(undefined, 1534.56)).toEqual({ start: 0, end: 1534.56 })
  })

  it('turns Timeline captions into source times', () => {
    // "风筝挂住了" sits at 17.4 on the Timeline, 135.4 in the source file.
    const [kite] = segmentsToSource([seg('kite', 17.4, 18.76)], trimmed, 1534.56)
    expect(kite.startTime).toBeCloseTo(135.4)
    expect(kite.endTime).toBeCloseTo(136.76)
    expect(kite.words[0].startTime).toBeCloseTo(135.4)
  })

  it('brings a source-timed SRT onto the trimmed clip and drops lines that were cut off', () => {
    const mapped = sourceSegmentsToTimeline([seg('teaser', 20, 22), seg('song', 119.36, 120.92), seg('kite', 135.4, 136.76)], trimmed, 1534.56)
    expect(mapped.map((s) => s.id)).toEqual(['song', 'kite'])
    expect(mapped[1].startTime).toBeCloseTo(17.4)
  })

  it('puts outline beats back on the Timeline', () => {
    const outline: StoryOutline = { model: 'm', characters: [], beats: [{ id: 'b', startTime: 135, endTime: 160, kind: 'story', characterIds: [], summary: 's', include: true }] }
    expect(outlineToTimeline(outline, trimmed).beats[0]).toMatchObject({ startTime: 17, endTime: 42 })
  })

  it('changes nothing without a clip', () => {
    const segments = [seg('a', 1, 2)]
    expect(segmentsToSource(segments, undefined, 10)).toBe(segments)
    expect(sourceSegmentsToTimeline(segments, undefined, 10)).toBe(segments)
  })
})
