import { describe, it, expect } from 'vitest'
import { getEffectivePresentationMode } from './templates'

describe('getEffectivePresentationMode', () => {
  it("uses a scene's explicit override when set", () => {
    expect(getEffectivePresentationMode('device-compatibility-lineup', 'overlay')).toBe('overlay')
  })

  it('falls back to each cinematic template default when unset', () => {
    expect(getEffectivePresentationMode('tech-title-scene')).toBe('full-frame')
    expect(getEffectivePresentationMode('device-compatibility-lineup')).toBe('full-frame')
    expect(getEffectivePresentationMode('three-step-presenter-plan')).toBe('presenter-overlay')
  })

  it('falls back to plain overlay for the 10 original templates -- no behavior change for old scenes', () => {
    expect(getEffectivePresentationMode('lower-third')).toBe('overlay')
    expect(getEffectivePresentationMode('checklist')).toBe('overlay')
  })
})
