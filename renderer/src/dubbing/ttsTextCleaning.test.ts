import { describe, expect, it } from 'vitest'
import { cleanTextForSpeech, hasSpeakableText } from './ttsTextCleaning'

describe('cleanTextForSpeech', () => {
  it('strips a trailing parenthetical annotation', () => {
    expect(cleanTextForSpeech('I am fine. (laughs)')).toBe('I am fine.')
  })

  it('strips a leading bracketed annotation', () => {
    expect(cleanTextForSpeech('[music] Let us begin.')).toBe('Let us begin.')
  })

  it('strips a mid-sentence annotation, keeping both sides joined by a single space', () => {
    expect(cleanTextForSpeech('Wait (pause) what did you say?')).toBe('Wait what did you say?')
  })

  it('strips full-width bracket variants alongside Khmer text', () => {
    expect(cleanTextForSpeech('ខ្ញុំសុខសប្បាយ （សើច）')).toBe('ខ្ញុំសុខសប្បាយ')
  })

  it('strips multiple annotations in the same line', () => {
    expect(cleanTextForSpeech('(sighs) Fine. [pause] Whatever.')).toBe('Fine. Whatever.')
  })

  it('collapses to an empty string for text that is purely an annotation', () => {
    expect(cleanTextForSpeech('(laughs)')).toBe('')
  })

  it('passes through text with no annotations completely unchanged', () => {
    expect(cleanTextForSpeech('Hello, how are you today?')).toBe('Hello, how are you today?')
  })

  it('does not touch an unmatched/unbalanced bracket', () => {
    expect(cleanTextForSpeech('This (is fine')).toBe('This (is fine')
  })
})

describe('hasSpeakableText', () => {
  it('is false for lines with nothing a voice could say', () => {
    for (const text of ['♪♪', '...', '—', '[Music]', '(laughs)', '♪ [music] ♪', '']) expect(hasSpeakableText(text)).toBe(false)
  })

  it('is true for real dialogue in any script', () => {
    for (const text of ['ចាំខ្ញុំផង!', 'Where are you going?', '你好', '[sighs] Fine.', '2']) expect(hasSpeakableText(text)).toBe(true)
  })
})
