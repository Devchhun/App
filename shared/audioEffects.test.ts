import { describe, expect, it } from 'vitest'
import { AUDIO_EFFECT_PRESETS, audioEffectFilter, createDefaultAudioEffectSettings, isNeutralAudioEffect, sanitizeAudioEffectSettings } from './audioEffects'

describe('audioEffectFilter', () => {
  const base = createDefaultAudioEffectSettings()

  it('nothing to do for the neutral settings', () => {
    expect(isNeutralAudioEffect(base)).toBe(true)
    expect(audioEffectFilter(base)).toBe('')
  })

  it('every preset makes a chain that ends in the limiter', () => {
    for (const { id } of AUDIO_EFFECT_PRESETS.filter((p) => p.id !== 'none')) {
      const chain = audioEffectFilter({ ...base, preset: id })
      expect(chain.length).toBeGreaterThan(0)
      expect(chain.endsWith('alimiter=limit=0.95')).toBe(true)
    }
  })

  it('pitch presets keep the length (atempo undoes the rate change)', () => {
    expect(audioEffectFilter({ ...base, preset: 'deep', amount: 100 })).toBe('asetrate=33600,aresample=48000,atempo=1.4286,alimiter=limit=0.95')
    expect(audioEffectFilter({ ...base, preset: 'high', amount: 50 })).toContain('asetrate=57600,aresample=48000,atempo=0.8333')
  })

  it('bass and treble apply with or without a preset', () => {
    expect(audioEffectFilter({ ...base, bassDb: 6, trebleDb: -3 })).toBe('bass=g=6:f=100,treble=g=-3:f=6000,alimiter=limit=0.95')
  })

  it('cleans bad saved values', () => {
    expect(sanitizeAudioEffectSettings({ preset: 'nope' as never, amount: 500, bassDb: -99 })).toEqual({ preset: 'none', amount: 100, bassDb: -12, trebleDb: 0 })
  })
})
