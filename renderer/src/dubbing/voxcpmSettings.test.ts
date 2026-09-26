import { describe, expect, it } from 'vitest'
import { DEFAULT_VOXCPM_SETTINGS, parseStoredVoxCpmSettings, serializeVoxCpmSettings } from './voxcpmSettings'

describe('parseStoredVoxCpmSettings / serializeVoxCpmSettings', () => {
  it('round-trips a valid stored value exactly', () => {
    const settings = { engine: 'edge-tts' as const, installDir: 'D:\\Tools\\VoxCPM2', device: 'cuda' as const, pitchMatch: false, tone: 'natural' as const }
    expect(parseStoredVoxCpmSettings(serializeVoxCpmSettings(settings))).toEqual(settings)
  })

  it('keeps pitch match on for a value stored before the setting existed', () => {
    const parsed = parseStoredVoxCpmSettings(JSON.stringify({ engine: 'voxcpm2', installDir: 'D:\\Tools\\VoxCPM2', device: 'cuda' }))
    expect(parsed.pitchMatch).toBe(true)
    expect(parseStoredVoxCpmSettings(JSON.stringify({ pitchMatch: 'no' })).pitchMatch).toBe(true)
  })

  it('rejects an unknown engine, keeping the rest', () => {
    const parsed = parseStoredVoxCpmSettings(JSON.stringify({ engine: 'wav2lip', installDir: 'D:\\Tools\\VoxCPM2', device: 'cpu' }))
    expect(parsed.engine).toBe(DEFAULT_VOXCPM_SETTINGS.engine)
    expect(parsed.installDir).toBe('D:\\Tools\\VoxCPM2')
    expect(parsed.device).toBe('cpu')
  })

  it('falls back to defaults for missing/corrupt storage', () => {
    expect(parseStoredVoxCpmSettings(null)).toEqual(DEFAULT_VOXCPM_SETTINGS)
    expect(parseStoredVoxCpmSettings('not json')).toEqual(DEFAULT_VOXCPM_SETTINGS)
    expect(parseStoredVoxCpmSettings('{}')).toEqual(DEFAULT_VOXCPM_SETTINGS)
  })

  it('rejects an invalid device value, keeping the rest', () => {
    const parsed = parseStoredVoxCpmSettings(JSON.stringify({ installDir: 'D:\\Tools\\VoxCPM2', device: 'quantum' }))
    expect(parsed.installDir).toBe('D:\\Tools\\VoxCPM2')
    expect(parsed.device).toBe(DEFAULT_VOXCPM_SETTINGS.device)
  })

  it('rejects an empty installDir, keeping the device', () => {
    const parsed = parseStoredVoxCpmSettings(JSON.stringify({ installDir: '', device: 'cpu' }))
    expect(parsed.installDir).toBe(DEFAULT_VOXCPM_SETTINGS.installDir)
    expect(parsed.device).toBe('cpu')
  })
})

describe('voice tone', () => {
  it('defaults to balanced, keeps a stored choice and rejects a bogus one', () => {
    expect(parseStoredVoxCpmSettings(null).tone).toBe('balanced')
    expect(parseStoredVoxCpmSettings(JSON.stringify({ tone: 'natural' })).tone).toBe('natural')
    expect(parseStoredVoxCpmSettings(JSON.stringify({ tone: 'screaming' })).tone).toBe('balanced')
  })
})
