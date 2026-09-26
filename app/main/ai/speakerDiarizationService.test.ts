import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }))

const { buildGeminiCueTextPrompt, buildGeminiSpeakerDetectionPrompt, buildGeminiSrtPrompt, buildGeminiTimedTranscriptPrompt, cleanGeminiSrt, extractGeminiJsonObject, parseGeminiCueText, parseGeminiTimedTranscript, restoreChunkLines, splitSpan, MIN_SPLIT_SECONDS, TruncatedTranscriptionError, parseTimestampSeconds, unreadableTranscriptMessage } = await import('./speakerDiarizationService')

describe('Gemini timestamped transcript mode', () => {
  it('requests literal timestamp rows without translation or story narration', () => {
    const prompt = buildGeminiTimedTranscriptPrompt('auto', 60)
    expect(prompt).toContain('START_SECONDS<TAB>END_SECONDS<TAB>EXACT_SPOKEN_TEXT')
    expect(prompt).toContain('Audio is the only source')
    expect(prompt).toContain('Never translate, summarize, paraphrase')
    expect(prompt).toContain('NO_SPEECH')
  })

  it('accepts tab, pipe, arrow, and decimal-comma timestamp rows', () => {
    const result = parseGeminiTimedTranscript([
      '1.250\t2.500\tfirst line',
      '3.000 | 4.250 | second line',
      '[5,500 --> 6,750] third line'
    ].join('\n'))
    expect(result.map(({ startTime, endTime, verbatimText }) => ({ startTime, endTime, verbatimText }))).toEqual([
      { startTime: 1.25, endTime: 2.5, verbatimText: 'first line' },
      { startTime: 3, endTime: 4.25, verbatimText: 'second line' },
      { startTime: 5.5, endTime: 6.75, verbatimText: 'third line' }
    ])
  })

  it('accepts normal SRT as a safe Gemini fallback', () => {
    const result = parseGeminiTimedTranscript('1\n00:00:01,100 --> 00:00:02,300\nspoken text')
    expect(result[0]).toMatchObject({ startTime: 1.1, endTime: 2.3, verbatimText: 'spoken text' })
  })

  it('treats NO_SPEECH as an empty result', () => {
    expect(parseGeminiTimedTranscript('NO_SPEECH')).toEqual([])
  })
})

describe('Gemini speaker detection prompt', () => {
  it('requires verbatim full-dialogue transcription with timestamps', () => {
    const prompt = buildGeminiSpeakerDetectionPrompt('auto')
    expect(prompt).toContain('every audible spoken line exactly once')
    expect(prompt).toContain('precise startTime and endTime')
    expect(prompt).toContain('Do not translate, summarize, paraphrase')
    expect(prompt).toContain('overlapping dialogue')
    expect(prompt).toContain('Set task exactly to "verbatim_transcription"')
    expect(prompt).toContain('Never write narration, a story recap')
    expect(prompt).toContain('only words actually heard in verbatimText')
    expect(prompt).toContain('normal SRT like the user\'s reference')
    expect(prompt).toContain('never force it to 0')
    expect(prompt).toContain('Silent sections create no subtitle')
    expect(prompt).toContain('Never merge different speakers into one cue')
    expect(prompt).toContain('Speaker identity belongs only in speakerNumber')
  })

  it('keeps recurring identity independent from gender and exposes uncertainty', () => {
    const prompt = buildGeminiSpeakerDetectionPrompt('km')
    expect(prompt).toContain('same speakerNumber whenever the same real voice returns')
    expect(prompt).toContain('never identify or merge people from gender alone')
    expect(prompt).toContain('Use unknown when evidence is weak')
    expect(prompt).toContain('Requested language hint: km')
  })
})

describe('Gemini transcription JSON extraction', () => {
  it('accepts the JSON markdown wrapper some Gemini versions return', () => {
    expect(extractGeminiJsonObject('```json\n{"task":"verbatim_transcription","lines":[]}\n```'))
      .toBe('{"task":"verbatim_transcription","lines":[]}')
  })

  it('ignores harmless text outside a complete JSON object', () => {
    expect(extractGeminiJsonObject('Result:\n{"task":"verbatim_transcription"}\nDone'))
      .toBe('{"task":"verbatim_transcription"}')
  })

  it('rejects a response without a complete JSON object', () => {
    expect(() => extractGeminiJsonObject('{"task":"verbatim_transcription"'))
      .toThrow('Gemini did not return a JSON transcription')
  })
})

describe('long-audio chunk timestamp restoration', () => {
  const line = (startTime: number, endTime: number, verbatimText: string) => ({
    startTime, endTime, verbatimText, speakerNumber: 1, language: 'zh', transcriptionConfidence: 0.98, identityConfidence: 0.9
  })

  it('restores chunk-relative timestamps to the original video timeline', () => {
    const restored = restoreChunkLines([line(3.2, 4.8, 'hello')], 118, 120, 240, false)
    expect(restored[0]).toMatchObject({ startTime: 121.2, endTime: 122.8, verbatimText: 'hello' })
  })

  it('uses the core midpoint so overlap context never duplicates subtitles', () => {
    const restored = restoreChunkLines([
      line(0.2, 1.2, 'belongs to previous chunk'),
      line(2.2, 3.2, 'belongs to this chunk')
    ], 118, 120, 240, false)
    expect(restored.map((item) => item.verbatimText)).toEqual(['belongs to this chunk'])
  })
})

describe('raw Gemini SRT mode', () => {
  it('requests standard SRT only and explicitly rejects recap text and JSON', () => {
    const prompt = buildGeminiSrtPrompt('zh', 120)
    expect(prompt).toContain('Return raw SRT only')
    expect(prompt).toContain('do not return JSON')
    expect(prompt).toContain('Never add story recap')
    expect(prompt).toContain('exact spoken text')
    expect(prompt).toContain('Recognition hint: zh')
  })

  it('unwraps an SRT markdown fence without changing subtitle contents', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n你好'
    expect(cleanGeminiSrt(`\`\`\`srt\n${srt}\n\`\`\``)).toBe(srt)
  })

  it('treats Gemini NO_SPEECH as an empty chunk', () => {
    expect(cleanGeminiSrt('NO_SPEECH')).toBe('')
  })
})

describe('Gemini final cue text over Whisper timing', () => {
  it('makes audio authoritative and forbids translation or recap', () => {
    const prompt = buildGeminiCueTextPrompt([{ key: 'CUE_1', startTime: 1.2, endTime: 2.8 }], 'km')
    expect(prompt).toContain('Audio is authoritative')
    expect(prompt).toContain('Whisper supplied timing boundaries only')
    expect(prompt).toContain('Never translate, summarize')
    expect(prompt).toContain('CUE_1\t1.200\t2.800')
  })

  it('parses tab, pipe and colon cue responses without mixing metadata into text', () => {
    const parsed = parseGeminiCueText('CUE_1\tសួស្តី\nCUE_2 | 你好\nCUE_3: hello')
    expect(parsed.get('CUE_1')).toBe('សួស្តី')
    expect(parsed.get('CUE_2')).toBe('你好')
    expect(parsed.get('CUE_3')).toBe('hello')
  })

  it('drops explicit empty speech ranges', () => {
    expect(parseGeminiCueText('CUE_1\t<EMPTY>').size).toBe(0)
  })
})

describe('splitting a span whose transcript overflowed', () => {
  it('halves a normal 64-second chunk at its midpoint', () => {
    expect(splitSpan(58, 122)).toEqual([58, 90])
  })

  it('stops splitting once a span is short enough that output is not the problem', () => {
    expect(splitSpan(0, MIN_SPLIT_SECONDS)).toBeNull()
    expect(splitSpan(10, 10 + MIN_SPLIT_SECONDS - 1)).toBeNull()
    expect(splitSpan(0, MIN_SPLIT_SECONDS + 1)).toEqual([0, (MIN_SPLIT_SECONDS + 1) / 2])
  })

  it('bottoms out after a few halvings of a 64-second chunk', () => {
    let spans: Array<[number, number]> = [[0, 64]]
    let rounds = 0
    while (spans.some(([start, end]) => splitSpan(start, end))) {
      spans = spans.flatMap(([start, end]) => {
        const split = splitSpan(start, end)
        return split ? [[start, split[1]], [split[1], end]] as Array<[number, number]> : [[start, end]]
      })
      rounds++
    }
    expect(rounds).toBe(3)
    expect(spans).toHaveLength(8)
  })

  it('marks a truncated transcript with its own error type and the familiar message', () => {
    const error = new TruncatedTranscriptionError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TruncatedTranscriptionError')
    expect(error.message).toBe('Gemini transcription was truncated for this audio part.')
  })
})

describe('clock-style timestamps from Gemini', () => {
  it('reads plain seconds and every clock layout as seconds', () => {
    expect(parseTimestampSeconds('61.36')).toBeCloseTo(61.36)
    expect(parseTimestampSeconds('01:01.360')).toBeCloseTo(61.36)
    expect(parseTimestampSeconds('1:01,36')).toBeCloseTo(61.36)
    expect(parseTimestampSeconds('0:01:01.360')).toBeCloseTo(61.36)
    expect(parseTimestampSeconds('1:02:03')).toBe(3723)
    expect(parseTimestampSeconds('abc')).toBeNaN()
  })

  it('accepts transcript rows written with MM:SS timestamps', () => {
    const result = parseGeminiTimedTranscript([
      '00:01.360\t00:02.920\t你好',
      '[00:03.200 - 00:04.800] 你去哪里',
      '0:05,500 --> 0:06,750 | third line',
      '00:59.000 to 01:01.500: across the minute'
    ].join('\n'))
    expect(result.map((line) => [line.startTime, line.endTime, line.verbatimText])).toEqual([
      [1.36, 2.92, '你好'],
      [3.2, 4.8, '你去哪里'],
      [5.5, 6.75, 'third line'],
      [59, 61.5, 'across the minute']
    ])
  })

  it('still reads the plain-seconds rows it always did', () => {
    const result = parseGeminiTimedTranscript('1.250\t2.500\tfirst line')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ startTime: 1.25, endTime: 2.5, verbatimText: 'first line' })
  })
})

describe('unreadable transcript message', () => {
  it('shows what Gemini actually answered', () => {
    expect(unreadableTranscriptMessage('Here is the transcript of the audio', 'STOP'))
      .toBe('Gemini did not return timestamped dialogue for this audio part. It returned: "Here is the transcript of the audio"')
  })

  it('names a blocking finish reason and an empty answer', () => {
    expect(unreadableTranscriptMessage('', 'RECITATION'))
      .toBe('Gemini did not return timestamped dialogue for this audio part. Gemini stopped with RECITATION. It returned an empty answer.')
  })

  it('shortens a long answer', () => {
    const message = unreadableTranscriptMessage('x'.repeat(300), 'STOP')
    expect(message).toContain('x'.repeat(120) + '…')
    expect(message).not.toContain('x'.repeat(121))
  })
})
