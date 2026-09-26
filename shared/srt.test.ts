import { describe, it, expect } from 'vitest'
import { parseSrtToSegments, transcriptSegmentsToSrt, validateSegmentsAgainstDuration } from './srt'

describe('parseSrtToSegments', () => {
  it('parses a basic well-formed SRT file', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,500',
      'Hello world',
      '',
      '2',
      '00:00:05,000 --> 00:00:07,250',
      'Second line'
    ].join('\n')

    const { segments, issues } = parseSrtToSegments(srt)

    expect(issues).toEqual([])
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ startTime: 1, endTime: 4.5, text: 'Hello world' })
    expect(segments[1]).toMatchObject({ startTime: 5, endTime: 7.25, text: 'Second line' })
  })

  it('strips a UTF-8 BOM and normalizes CRLF line endings', () => {
    const srt = '﻿1\r\n00:00:00,000 --> 00:00:02,000\r\nBOM test\r\n'
    const { segments, issues } = parseSrtToSegments(srt)
    expect(issues).toEqual([])
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('BOM test')
  })

  it('preserves original text, order, start and end time -- including multiline Khmer text', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:03,000',
      'សួស្តី​ពិភពលោក',
      'This is a second line in the same block',
      '',
      '2',
      '00:00:03,500 --> 00:00:06,000',
      'ជំរាបសួរ'
    ].join('\n')

    const { segments, issues } = parseSrtToSegments(srt)

    expect(issues).toEqual([])
    expect(segments).toHaveLength(2)
    // Multiline text is preserved with its internal line break, not merged into one line.
    expect(segments[0].text).toBe('សួស្តី​ពិភពលោក\nThis is a second line in the same block')
    expect(segments[0].startTime).toBe(0)
    expect(segments[0].endTime).toBe(3)
    expect(segments[1].text).toBe('ជំរាបសួរ')
    // Order preserved: segment 1 (earlier start) comes before segment 2.
    expect(segments.map((s) => s.text)).toEqual([segments[0].text, segments[1].text])
  })

  it('synthesizes a single word spanning the whole segment (SRT has no word-level timing)', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nOne word span'
    const { segments } = parseSrtToSegments(srt)
    expect(segments[0].words).toEqual([{ text: 'One word span', startTime: 0, endTime: 2, confidence: 1 }])
  })

  it('rejects a block with no timestamp line, without corrupting the rest of the file', () => {
    const srt = ['1', 'this is not a timestamp', 'stray text', '', '2', '00:00:05,000 --> 00:00:06,000', 'Valid segment'].join('\n')

    const { segments, issues } = parseSrtToSegments(srt)

    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Valid segment')
    expect(issues).toHaveLength(1)
    expect(issues[0].reason).toMatch(/no valid timestamp/i)
  })

  it('rejects a block whose end time is not after its start time', () => {
    const srt = '1\n00:00:05,000 --> 00:00:03,000\nBackwards range'
    const { segments, issues } = parseSrtToSegments(srt)
    expect(segments).toHaveLength(0)
    expect(issues).toHaveLength(1)
    expect(issues[0].reason).toMatch(/end time is not after/i)
  })

  it('rejects a block with an empty subtitle text', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\n'
    const { segments, issues } = parseSrtToSegments(srt)
    expect(segments).toHaveLength(0)
    expect(issues).toHaveLength(1)
    expect(issues[0].reason).toMatch(/empty subtitle text/i)
  })

  it('accepts a period as the decimal separator (non-standard exporter)', () => {
    const srt = '1\n00:00:01.000 --> 00:00:02.000\nPeriod separator'
    const { segments, issues } = parseSrtToSegments(srt)
    expect(issues).toEqual([])
    expect(segments[0]).toMatchObject({ startTime: 1, endTime: 2 })
  })

  it('handles a long file with hundreds of segments, all parsed correctly and quickly', () => {
    const blocks: string[] = []
    const COUNT = 800
    for (let i = 0; i < COUNT; i++) {
      const start = i * 3
      const end = start + 2
      const fmt = (s: number): string => {
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},000`
      }
      blocks.push(`${i + 1}\n${fmt(start)} --> ${fmt(end)}\nSegment number ${i + 1}`)
    }
    const srt = blocks.join('\n\n')

    const startedAt = Date.now()
    const { segments, issues } = parseSrtToSegments(srt)
    const elapsedMs = Date.now() - startedAt

    expect(issues).toEqual([])
    expect(segments).toHaveLength(COUNT)
    expect(segments[0].text).toBe('Segment number 1')
    expect(segments[COUNT - 1].text).toBe(`Segment number ${COUNT}`)
    expect(elapsedMs).toBeLessThan(1000)
  })
})

describe('validateSegmentsAgainstDuration', () => {
  it('flags a segment extending past the video duration as needsReview, without dropping it', () => {
    const { segments: parsed } = parseSrtToSegments('1\n00:00:00,000 --> 00:00:10,000\nToo long')
    const { segments, warnings } = validateSegmentsAgainstDuration(parsed, 5)
    expect(segments).toHaveLength(1) // never dropped
    expect(segments[0].needsReview).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/1 segment/)
  })

  it('leaves in-range segments untouched, with no warnings', () => {
    const { segments: parsed } = parseSrtToSegments('1\n00:00:00,000 --> 00:00:02,000\nFine')
    const { segments, warnings } = validateSegmentsAgainstDuration(parsed, 10)
    expect(segments[0].needsReview).toBe(false)
    expect(warnings).toEqual([])
  })

  it('tolerates small rounding differences right at the duration boundary', () => {
    const { segments: parsed } = parseSrtToSegments('1\n00:00:00,000 --> 00:00:10,100\nBarely over')
    const { segments, warnings } = validateSegmentsAgainstDuration(parsed, 10)
    expect(segments[0].needsReview).toBe(false)
    expect(warnings).toEqual([])
  })

  it('pluralizes the warning correctly for multiple out-of-range segments', () => {
    const { segments: parsed } = parseSrtToSegments(
      ['1', '00:00:00,000 --> 00:00:20,000', 'A', '', '2', '00:00:21,000 --> 00:00:25,000', 'B'].join('\n')
    )
    const { warnings } = validateSegmentsAgainstDuration(parsed, 5)
    expect(warnings[0]).toMatch(/2 segments/)
    expect(warnings[0]).toMatch(/have been marked/)
  })
})

describe('transcriptSegmentsToSrt', () => {
  it('preserves segment order, numbering and millisecond timestamps', () => {
    const { segments } = parseSrtToSegments('1\n00:00:01,125 --> 00:00:02,750\nFirst\n\n2\n00:01:03,000 --> 00:01:04,500\nSecond')
    segments[0].speakerId = 'speaker-2'
    expect(transcriptSegmentsToSrt(segments)).toBe(
      '1\n00:00:01,125 --> 00:00:02,750\nFirst\n\n2\n00:01:03,000 --> 00:01:04,500\nSecond\n'
    )
  })
})
