import { describe, expect, it } from 'vitest'
import { unreadableScriptFor, voiceLanguageOf } from './ttsLanguage'

// Measured on Edge TTS km-KH-PisethNeural: Chinese -> NoAudioReceived every
// time; Khmer, English, digits and Khmer mixed with Chinese -> audio.
describe('lines a Khmer voice cannot read', () => {
  it('flags an untranslated Chinese line', () => {
    expect(unreadableScriptFor('当然了我这三味真火', 'km')).toBe('Chinese')
    expect(unreadableScriptFor('你以为我不敢杀你吗？今天就让你见识一下！', 'km')).toBe('Chinese')
  })
  it('names Japanese and Korean too', () => {
    expect(unreadableScriptFor('ありがとう', 'km')).toBe('Japanese')
    expect(unreadableScriptFor('감사합니다', 'km')).toBe('Korean')
  })
  it('leaves readable lines alone -- Khmer, English, digits, mixed', () => {
    for (const text of ['ខ្ញុំទៅផ្សារ', 'Where are you going?', '2024', 'ខ្ញុំ 当然了 ទៅ', '...']) expect(unreadableScriptFor(text, 'km'), text).toBeNull()
  })
  it('does not apply to voices that read Chinese themselves', () => {
    expect(unreadableScriptFor('当然了', 'zh')).toBeNull()
  })
  it('reads the language from an Edge voice name', () => {
    expect(voiceLanguageOf('km-KH-PisethNeural')).toBe('km')
    expect(voiceLanguageOf('en-US-AriaNeural')).toBe('en')
  })
})
