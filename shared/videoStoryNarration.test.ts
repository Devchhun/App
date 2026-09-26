import { describe, expect, it } from 'vitest'
import { mergeNarrationScenes, narrationToSrt, narrativeMediaRange, planVideoChunks, secondsToSrtTime } from './videoStoryNarration'
import type { TranscriptSegment } from './transcription'

const segment = (id: string, startTime: number, endTime: number): TranscriptSegment => ({
  id,
  startTime,
  endTime,
  text: id,
  words: [],
  language: 'en',
  confidence: 1,
  needsReview: false
})

describe('video story narration', () => {
  it('chunks long videos near subtitle boundaries with overlap', () => {
    const chunks = planVideoChunks(710, [segment('a', 0, 298), segment('b', 298, 602)], 300, 2)
    expect(chunks.length).toBe(3)
    expect(chunks[0].endTime).toBe(298)
    expect(chunks[1].startTime).toBe(296)
    expect(chunks.at(-1)?.endTime).toBe(710)
  })

  it('keeps the complete silent opening while limiting a long tail after dialogue', () => {
    const segments = [segment('opening dialogue', 119.36, 121), segment('ending dialogue', 580, 590)]
    const range = narrativeMediaRange(720, segments)
    expect(range).toEqual({ startTime: 0, endTime: 602 })
    const chunks = planVideoChunks(720, segments, 120, 2, range.startTime, range.endTime)
    expect(chunks[0].startTime).toBe(0)
    expect(chunks.at(-1)?.endTime).toBe(602)
    expect(chunks.every((chunk) => chunk.startTime >= range.startTime && chunk.endTime <= range.endTime)).toBe(true)
  })

  it('deduplicates overlap scenes and keeps the higher confidence result', () => {
    const scenes = mergeNarrationScenes([
      { id: 'one', startTime: 20, endTime: 25, dialogueSummary: '', visibleAction: '', khmerNarration: 'គាត់ដើរចូលមក។', confidence: 0.5 },
      { id: 'two', startTime: 21, endTime: 25.5, dialogueSummary: '', visibleAction: '', khmerNarration: 'គាត់ដើរចូលមក។', confidence: 0.9 }
    ])
    expect(scenes).toHaveLength(1)
    expect(scenes[0].confidence).toBe(0.9)
  })

  it('exports valid SRT timestamps and editable narration text', () => {
    expect(secondsToSrtTime(3661.234)).toBe('01:01:01,234')
    expect(narrationToSrt([{ id: 'one', startTime: 1.2, endTime: 3.4, dialogueSummary: '', visibleAction: '', khmerNarration: 'សាកល្បង', confidence: 1 }]))
      .toContain('00:00:01,200 --> 00:00:03,400\nសាកល្បង')
  })
})
