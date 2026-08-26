import { describe, it, expect } from 'vitest'
import { buildTemplateSwitchPatch } from './templateSwitch'

describe('buildTemplateSwitchPatch', () => {
  it('regression: replacing a full-frame Device Compatibility Lineup with Three-Step Presenter Plan does not carry over full-frame', () => {
    // The scene had no explicit override -- it was just inheriting Device
    // Compatibility Lineup's own default ('full-frame'), so there is nothing
    // "intentional" to preserve across the switch.
    const patch = buildTemplateSwitchPatch('three-step-presenter-plan', undefined)
    expect(patch.templateId).toBe('three-step-presenter-plan')
    expect(patch.presentationMode).toBeUndefined() // falls back to Three-Step's own default: presenter-overlay
  })

  it('also resets when the old scene had an explicit but incompatible mode', () => {
    const patch = buildTemplateSwitchPatch('three-step-presenter-plan', 'full-frame')
    expect(patch.presentationMode).toBeUndefined()
  })

  it('preserves an explicit mode the destination template also supports', () => {
    // Both Tech Title Scene and Device Compatibility Lineup support 'overlay'.
    const patch = buildTemplateSwitchPatch('device-compatibility-lineup', 'overlay')
    expect(patch.presentationMode).toBe('overlay')
  })

  it('always resets contentTransform on a template switch', () => {
    const patch = buildTemplateSwitchPatch('tech-title-scene', undefined)
    expect(patch.contentTransform).toBeUndefined()
  })

  it('switching to an original (non-cinematic) template clears any explicit mode, since it only supports overlay', () => {
    const patch = buildTemplateSwitchPatch('lower-third', 'full-frame')
    expect(patch.presentationMode).toBeUndefined()
  })

  it('switching to an original template preserves an explicit overlay override (the only mode it supports)', () => {
    const patch = buildTemplateSwitchPatch('lower-third', 'overlay')
    expect(patch.presentationMode).toBe('overlay')
  })
})
