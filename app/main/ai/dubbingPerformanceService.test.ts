import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))

import { buildPerformancePrompt, contextItem, parsePerformanceResponse } from './dubbingPerformanceService'
import { buildLineContexts } from '@shared/dubbingPerformance'

const lines = [
  { id: 'a', text: 'ខ្ញុំទៅហើយ។', speaker: 'Mother', startTime: 0, endTime: 2 },
  { id: 'b', text: '(ខឹង) ឯងកុហកខ្ញុំ!', speaker: 'Son', startTime: 2, endTime: 4 },
  { id: 'c', text: 'អ្វី?!', speaker: 'Mother', startTime: 4, endTime: 5 }
]

describe('Gemini performance analyzer', () => {
  it('sends each line with its context, speakers, duration, punctuation and tags', () => {
    const [, middle] = buildLineContexts(lines)
    const item = contextItem(middle)
    expect(item).toMatchObject({ id: 'b', speaker: 'Son', previousSpeaker: 'Mother', nextSpeaker: 'Mother', durationSeconds: 2, punctuation: '!', emotionTags: ['ខឹង'], role: 'dialogue' })
    expect(item.previous).toEqual(['Mother: ខ្ញុំទៅហើយ។'])
    expect(item.next).toEqual(['Mother: អ្វី?!'])
    const prompt = buildPerformancePrompt(buildLineContexts(lines))
    expect(prompt).toContain('Keep emotion continuous')
    expect(prompt).toContain('"id": "c"')
  })
  it('takes the structured JSON answer and validates every line', () => {
    const answer = JSON.stringify({
      lines: [
        { id: 'b', emotion: 'angry', emotionIntensity: 82, speakingStyle: 'hard, accusing', pace: 'fast', energy: 'high', delivery: 'sharp', pauseHints: [], emphasisWords: ['កុហក'] },
        { id: 'c', emotion: 'shocked', emotionIntensity: 78, speakingStyle: 'stunned', pace: 'slow', energy: 'medium', delivery: '', pauseHints: [{ after: 'អ្វី', duration: 'short' }], emphasisWords: [] },
        { id: 'zzz', emotion: 'happy', emotionIntensity: 50 }
      ]
    })
    const out = parsePerformanceResponse(answer, new Set(['a', 'b', 'c']))
    expect(Object.keys(out).sort()).toEqual(['b', 'c'])
    expect(out.b).toMatchObject({ emotion: 'angry', emotionIntensity: 82, analysisSource: 'ai', emphasisWords: ['កុហក'] })
    expect(out.c.pauseHints).toEqual([{ after: 'អ្វី', duration: 'short' }])
  })
  it('survives text around the JSON and rejects garbage', () => {
    expect(Object.keys(parsePerformanceResponse('Here: {"lines":[{"id":"a","emotion":"calm","emotionIntensity":30}]} done', new Set(['a'])))).toEqual(['a'])
    expect(parsePerformanceResponse('not json at all', new Set(['a']))).toEqual({})
  })
})
