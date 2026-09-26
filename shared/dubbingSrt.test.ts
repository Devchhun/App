import { describe, expect, it } from 'vitest'
import { buildDubbingSrt, DUBBING_SRT_MARKER, restoreDubbingWorkspace, splitDubbingSrt } from './dubbingSrt'
import { defaultDubbingSegmentState, type DubbingSegmentState, type DubbingSpeakerProfile } from './dubbing'
import { parseSrtToSegments } from './srt'
import type { TranscriptSegment } from './transcription'

function segment(id: string, start: number, end: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { id, words: [], startTime: start, endTime: end, language: 'en', confidence: 1, text, needsReview: false, ...extra }
}

const segments = [
  segment('a', 1, 2.5, 'Where are you going?', { speakerId: 'spk-1' }),
  segment('b', 3, 4.2, 'Original line', { speakerId: 'spk-2', editedText: 'ចាំខ្ញុំផង!' }),
  segment('c', 5, 6, 'No speaker here')
]

const lineStates: Record<string, DubbingSegmentState> = {
  a: { ...defaultDubbingSegmentState('a'), speakerId: 'spk-1', detectedGender: 'male', detectedConfidence: 0.9, voiceId: 'edge:km-KH-PisethNeural', voiceManuallyAssigned: true, ageGroup: 'adult', pitch: -2, speed: 1.1, volumeDb: 3, status: 'generated', generatedClipId: 'clip-9' },
  b: { ...defaultDubbingSegmentState('b'), speakerId: 'spk-2', detectedGender: 'female', voiceId: 'saved:my-voice', pitch: 1.5, speed: 0.9, volumeDb: -1, status: 'voice-assigned' }
}

const speakers: Record<string, DubbingSpeakerProfile> = {
  'spk-1': { id: 'spk-1', name: 'Hero', gender: 'male', genderConfidence: 0.8, ageCategory: 'adult', ageConfidence: 0.7, identityConfidence: 0.9, embedding: [0.123456, -0.5], segmentIds: ['a'], voiceId: 'edge:km-KH-PisethNeural', voiceManuallyAssigned: true },
  'spk-2': { id: 'spk-2', name: 'Sister', gender: 'female', genderConfidence: 0.95, ageCategory: 'child', ageConfidence: 0.6, identityConfidence: 0.8, embedding: [], segmentIds: ['b'], genderManualOverride: true }
}

describe('buildDubbingSrt', () => {
  const text = buildDubbingSrt(segments, { segments: lineStates, speakers })

  it('writes an ordinary SRT first, using the current (edited/translated) text', () => {
    const { srtText } = splitDubbingSrt(text)
    expect(srtText).toBe('1\n00:00:01,000 --> 00:00:02,500\nWhere are you going?\n\n2\n00:00:03,000 --> 00:00:04,200\nចាំខ្ញុំផង!\n\n3\n00:00:05,000 --> 00:00:06,000\nNo speaker here\n')
  })

  it('ends with one zero-length data cue at the last line\'s end, which players can never show', () => {
    // start === end: visible while start <= t < end, i.e. never. At the last
    // line's end it also does not lengthen the file in an editor.
    expect(text).toContain(`\n\n4\n00:00:06,000 --> 00:00:06,000\n${DUBBING_SRT_MARKER}\n{`)
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('is skipped by the SRT reader without a warning', () => {
    const parsed = parseSrtToSegments(text)
    expect(parsed.segments.map((s) => s.text)).toEqual(['Where are you going?', 'ចាំខ្ញុំផង!', 'No speaker here'])
    expect(parsed.issues).toEqual([])
  })

  it('writes only the data cue when there are no lines', () => {
    expect(buildDubbingSrt([], { segments: {}, speakers: {} })).toMatch(/^1\n00:00:00,000 --> 00:00:00,000\nNOTE creative-ai-editor dubbing v1\n\{/)
  })

  it('leaves out per-project bookkeeping and rounds voice fingerprints', () => {
    const { data } = splitDubbingSrt(text)
    expect(JSON.stringify(data)).not.toContain('clip-9')
    expect(JSON.stringify(data)).not.toContain('"status"')
    expect(data?.speakers['spk-1'].embedding).toEqual([0.1235, -0.5])
  })
})

describe('export → import restores the dubbing setup', () => {
  const text = buildDubbingSrt(segments, { segments: lineStates, speakers })
  const { srtText, data } = splitDubbingSrt(text)
  const cues = parseSrtToSegments(srtText).segments
  const restored = restoreDubbingWorkspace(cues, data!)

  it('brings back every line\'s gender, voice, pitch, speed and volume, matched by order', () => {
    const [first, second, third] = cues.map((cue) => restored.segments[cue.id])
    expect(first).toMatchObject({ speakerId: 'spk-1', detectedGender: 'male', voiceId: 'edge:km-KH-PisethNeural', voiceManuallyAssigned: true, ageGroup: 'adult', pitch: -2, speed: 1.1, volumeDb: 3 })
    expect(second).toMatchObject({ speakerId: 'spk-2', detectedGender: 'female', voiceId: 'saved:my-voice', pitch: 1.5, speed: 0.9, volumeDb: -1 })
    expect(third).toMatchObject({ detectedGender: 'unknown', pitch: 0, speed: 1, volumeDb: 0 })
    expect(restored.mismatch).toBe(false)
  })

  it('starts lines with a voice as "voice assigned", never as already generated', () => {
    expect(restored.segments[cues[0].id].status).toBe('voice-assigned')
    expect(restored.segments[cues[0].id].generatedClipId).toBeUndefined()
    expect(restored.segments[cues[2].id].status).toBe('pending')
  })

  it('brings back each speaker, re-linked to the new line ids', () => {
    expect(restored.speakers['spk-1']).toMatchObject({ name: 'Hero', gender: 'male', ageCategory: 'adult', voiceId: 'edge:km-KH-PisethNeural', segmentIds: [cues[0].id] })
    expect(restored.speakers['spk-2']).toMatchObject({ name: 'Sister', gender: 'female', ageCategory: 'child', genderManualOverride: true, segmentIds: [cues[1].id] })
    expect(restored.speakerIdBySegmentId).toEqual({ [cues[0].id]: 'spk-1', [cues[1].id]: 'spk-2' })
  })

  it('survives Windows line endings and a byte-order mark', () => {
    const windows = '﻿' + text.replace(/\n/g, '\r\n')
    const again = splitDubbingSrt(windows)
    expect(again.data?.lines).toHaveLength(3)
    expect(parseSrtToSegments(again.srtText).segments).toHaveLength(3)
  })
})

describe('robustness', () => {
  it('treats an ordinary SRT as having no dubbing data', () => {
    const plain = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'
    expect(splitDubbingSrt(plain)).toEqual({ srtText: plain, data: null })
  })

  it('keeps the cues when the data block is damaged', () => {
    const broken = `1\n00:00:01,000 --> 00:00:02,000\nHello\n\n${DUBBING_SRT_MARKER}\n{"version":1,"lines":[`
    const { srtText, data } = splitDubbingSrt(broken)
    expect(data).toBeNull()
    expect(parseSrtToSegments(srtText).segments).toHaveLength(1)
  })

  it('ignores values a hand-edited file should not contain', () => {
    const payload = { version: 1, lines: [{ detectedGender: 'robot', pitch: 999, speed: 'fast', volumeDb: -500, ageGroup: 'ancient', voiceId: 42 }], speakers: { '': { name: 'x' } } }
    const { data } = splitDubbingSrt(`1\n00:00:01,000 --> 00:00:02,000\nHi\n\n${DUBBING_SRT_MARKER}\n${JSON.stringify(payload)}\n`)
    expect(data?.lines[0]).toEqual({ detectedGender: 'unknown', pitch: 24, speed: 1, volumeDb: -60, speakerId: undefined, detectedConfidence: undefined, voiceId: undefined, voiceManuallyAssigned: undefined, ageGroup: undefined, isNarrator: undefined })
    expect(data?.speakers).toEqual({})
  })

  it('matches what it can when lines were added or removed, and says so', () => {
    const text = buildDubbingSrt(segments, { segments: lineStates, speakers })
    const { srtText, data } = splitDubbingSrt(text)
    const fewer = parseSrtToSegments(srtText).segments.slice(0, 2)
    const restored = restoreDubbingWorkspace(fewer, data!)
    expect(restored.mismatch).toBe(true)
    expect(restored.segments[fewer[1].id].detectedGender).toBe('female')
  })
})
