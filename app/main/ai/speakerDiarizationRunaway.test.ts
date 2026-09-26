import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }))

const { isRunawayRow, mapWithConcurrency, salvagePartialTranscript, salvageRunawayTranscript, transcriptTokenBudget, TruncatedTranscriptionError } = await import('./speakerDiarizationService')

const row = (start: number, end: number, text: string): string => `${start.toFixed(3)}\t${end.toFixed(3)}\t${text}`

describe('transcriptTokenBudget', () => {
  it('scales with the audio so a loop cannot run for minutes', () => {
    expect(transcriptTokenBudget(64)).toBe(6400)
    expect(transcriptTokenBudget(14)).toBe(2048)
  })

  it('never drops below a floor or rises above the model cap', () => {
    expect(transcriptTokenBudget(1)).toBe(2048)
    expect(transcriptTokenBudget(10_000)).toBe(32768)
  })
})

describe('salvageRunawayTranscript', () => {
  it('keeps the honest lines and drops a line repeated until the budget ran out', () => {
    const text = [
      row(0.5, 2.0, 'Where are you going?'),
      row(2.4, 4.1, 'To the village.'),
      row(4.6, 6.0, 'Wait for me!'),
      ...Array.from({ length: 12 }, (_, i) => row(7 + i, 7.8 + i, 'la la la')),
      '19.000\t19.8' // cut off mid-row when the budget ran out
    ].join('\n')
    const lines = salvageRunawayTranscript(text, 14)
    expect(lines?.map((line) => line.verbatimText)).toEqual(['Where are you going?', 'To the village.', 'Wait for me!', 'la la la'])
    // Salvaged lines are marked low-confidence so the editor flags them.
    expect(lines?.every((line) => line.transcriptionConfidence <= 0.5)).toBe(true)
  })

  it('catches a loop that alternates between two lines', () => {
    const text = [
      row(0.2, 1.0, 'Brother!'),
      ...Array.from({ length: 12 }, (_, i) => row(1 + i, 1.8 + i, i % 2 ? 'Go now.' : 'Run!')),
      row(13.2, 14.0, 'Run')
    ].join('\n')
    expect(salvageRunawayTranscript(text, 14)?.map((line) => line.verbatimText)).toEqual(['Brother!', 'Run!', 'Go now.'])
  })

  it('drops rows the model timed past the end of the audio', () => {
    const text = [
      row(0.5, 2.0, 'First line'),
      row(2.5, 4.0, 'Second line'),
      row(4.5, 6.0, 'Third line'),
      row(15, 16, 'ghost one'),
      row(17, 18, 'ghost two'),
      row(19, 20, 'ghost three'),
      row(21, 22, 'ghost four')
    ].join('\n')
    expect(salvageRunawayTranscript(text, 12)?.map((line) => line.verbatimText)).toEqual(['First line', 'Second line', 'Third line'])
  })

  it('returns null for a genuinely long transcript, so the audio gets split instead', () => {
    const text = Array.from({ length: 20 }, (_, i) => row(i * 3, i * 3 + 2, `different line number ${i}`)).join('\n')
    expect(salvageRunawayTranscript(text, 64)).toBeNull()
  })

  it('returns null when there is too little output to judge', () => {
    expect(salvageRunawayTranscript([row(0, 1, 'a'), row(1, 2, 'a'), row(2, 3, 'a')].join('\n'), 14)).toBeNull()
  })
})

describe('a loop inside a single line', () => {
  it('recognises a line that repeats the same short chunk or never ends', () => {
    expect(isRunawayRow('ha '.repeat(40))).toBe(true)
    expect(isRunawayRow('ហាហាហាហាហាហាហាហាហាហា')).toBe(true)
    expect(isRunawayRow('x'.repeat(301))).toBe(true)
    expect(isRunawayRow('Where are you going, brother?')).toBe(false)
    // Ordinary short repetition people actually say is not a loop.
    expect(isRunawayRow('No, no, no!')).toBe(false)
  })

  it('salvages a transcript whose only problem is one runaway line', () => {
    const text = [
      row(0.3, 1.9, 'Come back here!'),
      row(2.2, 3.4, 'I said come back!'),
      row(3.8, 8.0, 'la '.repeat(200))
    ].join('\n')
    // Too few rows for the row-repetition check, but the runaway line gives
    // it away: keep the two real lines, drop the loop.
    expect(salvageRunawayTranscript(text, 8)?.map((line) => line.verbatimText)).toEqual(['Come back here!', 'I said come back!'])
  })

  it('salvages nothing but still reports a loop when the very first line runs away', () => {
    expect(salvageRunawayTranscript(row(0, 8, 'na '.repeat(300)), 8)).toEqual([])
  })
})

describe('salvagePartialTranscript (last resort, never fails the job)', () => {
  it('keeps complete trustworthy lines and drops the cut-off last one', () => {
    const text = [row(0.5, 2, 'First real line'), row(2.5, 4, 'Second real line'), '4.500\t6.0'].join('\n')
    expect(salvagePartialTranscript(text, 8).map((line) => line.verbatimText)).toEqual(['First real line', 'Second real line'])
  })

  it('returns an empty list for output with nothing usable in it', () => {
    expect(salvagePartialTranscript('', 8)).toEqual([])
    expect(salvagePartialTranscript('complete nonsense with no timestamps', 8)).toEqual([])
  })

  it('carries the partial text on the truncation error for that salvage', () => {
    const error = new TruncatedTranscriptionError('0.5\t2.0\thello')
    expect(error.partialText).toBe('0.5\t2.0\thello')
    expect(error.message).toBe('Gemini transcription was truncated for this audio part.')
  })
})

describe('mapWithConcurrency', () => {
  it('keeps results in index order and never exceeds the limit', async () => {
    let running = 0
    let peak = 0
    const results = await mapWithConcurrency(7, 3, async (index) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, (7 - index) * 3))
      running--
      return index * 10
    })
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60])
    expect(peak).toBe(3)
  })

  it('stops starting new work after a failure', async () => {
    const started: number[] = []
    await expect(mapWithConcurrency(10, 2, async (index) => {
      started.push(index)
      if (index === 1) throw new Error('part 2 failed')
      await new Promise((resolve) => setTimeout(resolve, 5))
      return index
    })).rejects.toThrow('part 2 failed')
    expect(started.length).toBeLessThan(10)
  })
})
