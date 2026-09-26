import { describe, it, expect } from 'vitest'
import {
  savedVoiceId,
  isSavedVoiceId,
  savedVoiceIdToRaw,
  parseSavedVoices,
  serializeSavedVoices,
  addSavedVoice,
  removeSavedVoice,
  findSavedVoice,
  type SavedCustomVoice
} from './savedVoices'

function voice(overrides: Partial<SavedCustomVoice> & { id: string; name: string }): SavedCustomVoice {
  return { referenceAudioPath: `C:\\refs\\${overrides.id}.wav`, createdAt: '2026-01-01T00:00:00.000Z', ...overrides }
}

describe('saved voice ids', () => {
  it('namespaces a saved id so it can never collide with a catalog voice', () => {
    expect(savedVoiceId('abc')).toBe('saved:abc')
    expect(isSavedVoiceId('saved:abc')).toBe(true)
    expect(isSavedVoiceId('male-adult')).toBe(false)
  })

  it('round-trips back to the raw id', () => {
    expect(savedVoiceIdToRaw(savedVoiceId('abc'))).toBe('abc')
  })

  it('leaves a non-saved id alone rather than mangling it', () => {
    expect(savedVoiceIdToRaw('male-adult')).toBe('male-adult')
  })
})

describe('parseSavedVoices', () => {
  it('returns an empty list for nothing stored yet', () => {
    expect(parseSavedVoices(null)).toEqual([])
    expect(parseSavedVoices('')).toEqual([])
  })

  it('survives corrupt JSON instead of throwing into the panel', () => {
    expect(parseSavedVoices('{not json')).toEqual([])
  })

  it('survives a stored value that is not a list', () => {
    expect(parseSavedVoices('{"name":"x"}')).toEqual([])
  })

  it('round-trips a real list', () => {
    const list = [voice({ id: 'a', name: 'Wang Lin' })]
    expect(parseSavedVoices(serializeSavedVoices(list))).toEqual(list)
  })

  it('drops only the malformed entries, keeping the good ones', () => {
    const raw = JSON.stringify([
      voice({ id: 'a', name: 'Good' }),
      { id: 'b' },
      { id: 'c', name: '', referenceAudioPath: 'x', createdAt: 'y' },
      { name: 'no id', referenceAudioPath: 'x', createdAt: 'y' }
    ])
    const parsed = parseSavedVoices(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('Good')
  })
})

describe('addSavedVoice', () => {
  it('appends a new voice', () => {
    const list = addSavedVoice([], voice({ id: 'a', name: 'Wang Lin' }))
    expect(list.map((v) => v.name)).toEqual(['Wang Lin'])
  })

  it('re-recording the same character replaces its clip and KEEPS its id', () => {
    // Anything already assigned to this voice must follow the new recording,
    // which only works if the id survives.
    const first = addSavedVoice([], voice({ id: 'a', name: 'Wang Lin', referenceAudioPath: 'C:\\old.wav' }))
    const second = addSavedVoice(first, voice({ id: 'b', name: 'Wang Lin', referenceAudioPath: 'C:\\new.wav' }))
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe('a')
    expect(second[0].referenceAudioPath).toBe('C:\\new.wav')
  })

  it('treats names as the same regardless of case and padding', () => {
    const first = addSavedVoice([], voice({ id: 'a', name: 'Wang Lin' }))
    const second = addSavedVoice(first, voice({ id: 'b', name: '  wang lin  ' }))
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe('a')
  })

  it('keeps genuinely different characters apart', () => {
    const list = addSavedVoice(addSavedVoice([], voice({ id: 'a', name: 'Wang Lin' })), voice({ id: 'b', name: 'Master' }))
    expect(list).toHaveLength(2)
  })
})

describe('removeSavedVoice / findSavedVoice', () => {
  const list = [voice({ id: 'a', name: 'Wang Lin' }), voice({ id: 'b', name: 'Master' })]

  it('removes exactly the one asked for', () => {
    expect(removeSavedVoice(list, 'a').map((v) => v.id)).toEqual(['b'])
  })

  it('is a no-op for an id that is not there', () => {
    expect(removeSavedVoice(list, 'zzz')).toHaveLength(2)
  })

  it('finds a voice from the namespaced id a subtitle stores', () => {
    expect(findSavedVoice(list, savedVoiceId('b'))?.name).toBe('Master')
  })

  it('returns undefined for a catalog voice id', () => {
    expect(findSavedVoice(list, 'male-adult')).toBeUndefined()
  })

  it('returns undefined for a saved voice that has since been deleted', () => {
    expect(findSavedVoice(list, savedVoiceId('gone'))).toBeUndefined()
  })
})
