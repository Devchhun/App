import { describe, it, expect } from 'vitest'
import { splitRecapScript, estimateLineSeconds, buildRecapSrt, chunkRecapScript } from './recapNarration'
import { parseSrtToSegments } from '@shared/srt'

describe('splitRecapScript', () => {
  it('splits on Khmer and Latin sentence ends and on newlines', () => {
    expect(splitRecapScript('វ៉ាងលីនដើរចូលព្រៃ។ គាត់ឃើញស្តេចនាគ។\nThe end. Really!')).toEqual([
      'វ៉ាងលីនដើរចូលព្រៃ។',
      'គាត់ឃើញស្តេចនាគ។',
      'The end.',
      'Really!'
    ])
  })

  it('splits Khmer sentences even with no space after ។', () => {
    expect(splitRecapScript('មួយ។ពីរ។បី។')).toEqual(['មួយ។', 'ពីរ។', 'បី។'])
  })

  it('drops blank pieces and trims', () => {
    expect(splitRecapScript('  one.  \n\n\n  two  ')).toEqual(['one.', 'two'])
  })

  it('breaks an over-long sentence at clause breaks', () => {
    const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} with some words`).join(', ')
    const lines = splitRecapScript(long)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(200)
    expect(lines.join(' ')).toBe(long)
  })
})

describe('chunkRecapScript', () => {
  it('keeps consecutive sentences together up to the limit, and breaks at paragraphs', () => {
    const text = 'មួយ។ ពីរ។ បី។\nបួន។ ប្រាំ។'
    expect(chunkRecapScript(text, 320)).toEqual(['មួយ។ ពីរ។ បី។', 'បួន។ ប្រាំ។'])
  })

  it('splits a long paragraph into several chunks at sentence ends', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const chunks = chunkRecapScript(text, 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80 + 30)
    expect(chunks.join(' ')).toBe(text)
  })
})

describe('estimateLineSeconds', () => {
  it('gives Khmer text more time per character than Latin and floors short lines', () => {
    expect(estimateLineSeconds('ok')).toBe(1.2)
    expect(estimateLineSeconds('ខ្ញុំទៅផ្សារ')).toBeGreaterThan(estimateLineSeconds('I go to market'))
  })
})

describe('buildRecapSrt', () => {
  it('produces SRT the app parser accepts, laid end to end', () => {
    const { srtText, lineCount, totalSeconds } = buildRecapSrt(['first line.', 'second line here.'], { gapSeconds: 0.5 })
    const { segments } = parseSrtToSegments(srtText)
    expect(lineCount).toBe(2)
    expect(segments).toHaveLength(2)
    expect(segments[0].startTime).toBe(0)
    expect(segments[1].startTime).toBeCloseTo(segments[0].endTime + 0.5, 2)
    expect(totalSeconds).toBeCloseTo(segments[1].endTime, 2)
    expect(segments[1].text).toBe('second line here.')
  })
})
