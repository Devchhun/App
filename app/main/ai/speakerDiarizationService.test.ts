import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }))

const { cleanPartLines, isTooSparse, timesLookCompressed, repairMinuteSecondTimes, salvageCoversPart, buildGeminiCueTextPrompt, buildGeminiSpeakerDetectionPrompt, buildGeminiSrtPrompt, buildGeminiTimedTranscriptPrompt, cleanGeminiSrt, extractGeminiJsonObject, parseGeminiCueText, parseGeminiTimedTranscript, restoreChunkLines, splitSpan, MIN_SPLIT_SECONDS, TruncatedTranscriptionError, parseTimestampSeconds, unreadableTranscriptMessage } = await import('./speakerDiarizationService')

describe('Gemini timestamped transcript mode', () => {
  it('requests literal timestamp rows without translation or story narration', () => {
    const prompt = buildGeminiTimedTranscriptPrompt('auto', 60)
    expect(prompt).toContain('START_SECONDS<TAB>END_SECONDS<TAB>VOICE<TAB>EXACT_SPOKEN_TEXT')
    // The voice is judged by ear, not by pitch alone (a shouting man is still a man).
    expect(prompt).toContain('M = a man (also when he shouts, cries or is angry)')
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

  it('reads the VOICE column, and still reads rows without one', () => {
    const result = parseGeminiTimedTranscript(['1.000\t2.000\tM\t你好', '3.000 | 4.000 | F | 你去哪里', '5.000\t6.000\tU\t啊', '7.000\t8.000\tno voice column'].join('\n'))
    expect(result.map(({ verbatimText, voice }) => ({ verbatimText, voice }))).toEqual([
      { verbatimText: '你好', voice: 'male' },
      { verbatimText: '你去哪里', voice: 'female' },
      { verbatimText: '啊', voice: 'unknown' },
      { verbatimText: 'no voice column', voice: undefined }
    ])
  })

  it('takes a VOICE put after the text off the text, so it is never spoken', () => {
    expect(parseGeminiTimedTranscript('1.000\t2.000\t你好\tM')[0]).toMatchObject({ verbatimText: '你好', voice: 'male' })
  })

  it('reads M* / F* as an inner voice (a thought), plain M/F as speech', () => {
    const result = parseGeminiTimedTranscript(['1.000\t2.000\tM*\t他到底想干什么', '3.000\t4.000\tF\t你好', '5.000\t6.000\t怎么办\tF*'].join('\n'))
    expect(result.map(({ verbatimText, voice, innerVoice }) => ({ verbatimText, voice, innerVoice }))).toEqual([
      { verbatimText: '他到底想干什么', voice: 'male', innerVoice: true },
      { verbatimText: '你好', voice: 'female', innerVoice: undefined },
      { verbatimText: '怎么办', voice: 'female', innerVoice: true }
    ])
    expect(buildGeminiTimedTranscriptPrompt('auto', 60)).toContain('INNER VOICE')
  })

  it('keeps a row whose VOICE came before the times (it used to be dropped -- a missing line)', () => {
    const result = parseGeminiTimedTranscript(['M\t1.000\t2.000\t你好', 'F* | 3.000 | 4.000 | 怎么办', '5.000\t6.000\tU\t走吧'].join('\n'))
    expect(result.map(({ startTime, verbatimText, voice, innerVoice }) => ({ startTime, verbatimText, voice, innerVoice }))).toEqual([
      { startTime: 1, verbatimText: '你好', voice: 'male', innerVoice: undefined },
      { startTime: 3, verbatimText: '怎么办', voice: 'female', innerVoice: true },
      { startTime: 5, verbatimText: '走吧', voice: 'unknown', innerVoice: undefined }
    ])
  })

  it('cleans a part: repetition loops, lines past its end, implausible inner-voice marks', () => {
    const at = (t: number, text: string, innerVoice?: boolean) => ({ startTime: t, endTime: t + 0.5, verbatimText: text, speakerNumber: 1, language: 'zh', transcriptionConfidence: 1, identityConfidence: 0, ...(innerVoice ? { innerVoice } : {}) })
    // "啊!" 69 times, one every half second (a real fallback answer): one kept.
    const loop = Array.from({ length: 69 }, (_, i) => at(i * 0.5, '啊!'))
    expect(cleanPartLines(loop, 64).map((l) => l.verbatimText)).toEqual(['啊!'])
    // Three real repeats stay.
    expect(cleanPartLines([at(1, '走!'), at(2, '走!'), at(3, '走!'), at(5, '好')], 64)).toHaveLength(4)
    // A nonsense time past the part is dropped.
    expect(cleanPartLines([at(119.9, '出'), at(3, '好')], 64).map((l) => l.verbatimText)).toEqual(['好'])
    // Every line "inner voice": the marks go; a few marked lines keep theirs.
    const allMarked = [at(1, '一', true), at(3, '二', true), at(5, '三', true), at(7, '四', true)]
    expect(cleanPartLines(allMarked, 64).some((l) => l.innerVoice)).toBe(false)
    const oneMarked = [at(1, '一', true), at(3, '二'), at(5, '三'), at(7, '四')]
    expect(cleanPartLines(oneMarked, 64).filter((l) => l.innerVoice)).toHaveLength(1)
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

  it('puts back a part Gemini wrote in absolute video times (its lines used to be dropped)', () => {
    // Part 5: file 238..302, core 240..300. Gemini wrote 245 s / 280 s
    // instead of 7 s / 42 s.
    const restored = restoreChunkLines([line(245, 247, 'a'), line(280, 282.5, 'b')], 238, 240, 300, false)
    expect(restored.map((item) => [item.startTime, item.endTime, item.verbatimText])).toEqual([[245, 247, 'a'], [280, 282.5, 'b']])
  })

  it('leaves ordinary part-relative times alone', () => {
    const restored = restoreChunkLines([line(7, 9, 'a'), line(42, 44, 'b')], 238, 240, 300, false)
    expect(restored.map((item) => item.startTime)).toEqual([245, 280])
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

describe('salvageCoversPart', () => {
  it('a loop after the first rows of a minute does not cover it', () => {
    expect(salvageCoversPart([{ endTime: 3 }, { endTime: 6.5 }], 64)).toBe(false)
  })
  it('lines reaching near the end do', () => {
    expect(salvageCoversPart([{ endTime: 10 }, { endTime: 50 }], 64)).toBe(true)
  })
  it('a short part always counts as covered, so halving stops', () => {
    expect(salvageCoversPart([], 16)).toBe(true)
    expect(salvageCoversPart([], 32)).toBe(false)
  })
})

describe('cleanPartLines drops rows that are not speech', () => {
  it('NO_SPEECH written as a row, sound tags and music notes', () => {
    const row = (startTime: number, verbatimText: string) => ({ startTime, endTime: startTime + 1, verbatimText, speakerNumber: 1, language: 'zh', transcriptionConfidence: 1, identityConfidence: 0 })
    const kept = cleanPartLines([row(1, '什么东西?'), row(2, 'NO_SPEECH'), row(3, '[音乐]'), row(4, '(sighs)'), row(5, '♪ ♪'), row(6, '传送阵。'), row(7, 'no speech.')], 60)
    expect(kept.map((line) => line.verbatimText)).toEqual(['什么东西?', '传送阵。'])
  })
})

describe('repairMinuteSecondTimes', () => {
  const at = (startTime: number, endTime: number) => ({ startTime, endTime })
  it('reads m.ss(s) times Gemini wrote as plain seconds (measured on a real part)', () => {
    const fixed = repairMinuteSecondTimes([at(0, 0.009), at(0.009, 0.056), at(0.056, 0.199), at(0.565, 0.584), at(0.584, 1.04)], 64)
    expect(fixed.map((l) => [l.startTime, l.endTime])).toEqual([[0, 0.9], [0.9, 5.6], [5.6, 19.9], [56.5, 58.4], [58.4, 64]])
  })
  it('keeps ordinary times', () => {
    const lines = [at(0.5, 2), at(3, 5.5), at(40, 44)]
    expect(repairMinuteSecondTimes(lines, 64)).toBe(lines)
  })
  it('keeps a short burst at the start of a long part when it is not a valid m.ss reading', () => {
    const lines = [at(0.1, 0.7), at(0.7, 1.2), at(1.2, 2.9)]
    expect(repairMinuteSecondTimes(lines, 64)).toBe(lines)
  })
  it('cleanPartLines applies it', () => {
    const row = (startTime: number, endTime: number, verbatimText: string) => ({ startTime, endTime, verbatimText, speakerNumber: 1, language: 'km', transcriptionConfidence: 1, identityConfidence: 0 })
    const kept = cleanPartLines([row(0, 0.06, 'ក'), row(0.06, 0.2, 'ខ'), row(0.2, 0.25, 'គ'), row(0.25, 0.4, 'ង'), row(0.61, 0.64, 'ឃ')], 64)
    expect(kept.map((l) => l.startTime)).toEqual([0, 6, 20, 25, 61])
  })
})

describe('answers with unusable timing or too little in them', () => {
  const at = (startTime: number, endTime: number) => ({ startTime, endTime })
  it('stretches a compressed part in proportion when no reading fits (measured: 0 .. 1.160 for a 64 s part)', () => {
    const lines = [at(0, 0.02), at(0.02, 0.05), at(0.05, 0.08), at(0.5, 0.55), at(0.99, 1.03), at(1.13, 1.16)]
    expect(timesLookCompressed(lines, 64)).toBe(true)
    const fixed = repairMinuteSecondTimes(lines, 64)
    expect(fixed[fixed.length - 1].endTime).toBeCloseTo(64)
    expect(fixed[3].startTime).toBeCloseTo(0.5 * 64 / 1.16)
  })
  it('real seconds are not compressed', () => {
    expect(timesLookCompressed([at(1, 2), at(10, 12), at(20, 22), at(30, 33), at(50, 60)], 64)).toBe(false)
  })
  it('one 0.07 s line for a minute is too sparse; a few lines across it are not', () => {
    expect(isTooSparse([at(0, 0.067)], 64)).toBe(true)
    expect(isTooSparse([], 20)).toBe(true)
    expect(isTooSparse([at(2, 5), at(40, 50)], 64)).toBe(false)
    expect(isTooSparse([at(2, 5), at(6, 8), at(9, 11)], 64)).toBe(false)
    expect(isTooSparse([at(2, 5)], 30)).toBe(false)
  })
  it('reads minutes.seconds.milliseconds rows ("1.02.400")', () => {
    const lines = parseGeminiTimedTranscript('1.02.400	1.03.500	M	ភ្លាមៗ នោះ')
    expect(lines).toHaveLength(1)
    expect(lines[0].startTime).toBeCloseTo(62.4)
    expect(lines[0].endTime).toBeCloseTo(63.5)
  })
})
