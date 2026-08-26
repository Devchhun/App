import { describe, it, expect } from 'vitest'
import { deriveStepItems } from './ThreeStepPresenterPlan'
import { deriveDeviceItems, resolveDeviceIconAndColor } from './DeviceCompatibilityLineup'
import type { Scene } from '@shared/project'

function baseScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    mediaId: 'm1',
    segmentId: 'seg1',
    suggestionId: 'sug1',
    track: 'V2',
    templateId: 'three-step-presenter-plan',
    startTime: 0,
    endTime: 4,
    purpose: 'sequence_of_steps',
    originalText: '',
    visualText: 'Install, Connect, Go',
    reason: '',
    confidence: 1,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date(0).toISOString(),
    ...overrides
  }
}

describe('deriveStepItems', () => {
  it('uses explicit content.items when present', () => {
    const scene = baseScene({ content: { items: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }, { id: 'c', label: 'Three' }] } })
    expect(deriveStepItems(scene).map((i) => i.label)).toEqual(['One', 'Two', 'Three'])
  })

  it('falls back to splitting visualText for an old scene saved before content.items existed (backward compatible)', () => {
    const oldScene = baseScene({ content: undefined, visualText: 'Install, Connect, Go' })
    const items = deriveStepItems(oldScene)
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.label)).toEqual(['Install', 'Connect', 'Go'])
  })

  it('always returns exactly 3 items even when visualText has fewer parts', () => {
    const scene = baseScene({ content: undefined, visualText: 'Just one phrase' })
    expect(deriveStepItems(scene)).toHaveLength(3)
  })

  it('is a pure, deterministic function of the scene (same input -> same output)', () => {
    const scene = baseScene({ content: undefined })
    expect(deriveStepItems(scene)).toEqual(deriveStepItems(scene))
  })
})

describe('deriveDeviceItems', () => {
  it('uses explicit content.items when present, capped at 4', () => {
    const scene = baseScene({
      templateId: 'device-compatibility-lineup',
      content: { items: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }, { id: 'c', label: 'Three' }, { id: 'd', label: 'Four' }, { id: 'e', label: 'Five' }] }
    })
    expect(deriveDeviceItems(scene)).toHaveLength(4)
  })

  it('falls back to the four default devices for an old scene with no content (backward compatible)', () => {
    const oldScene = baseScene({ templateId: 'device-compatibility-lineup', content: undefined })
    const items = deriveDeviceItems(oldScene)
    expect(items).toHaveLength(4)
    expect(items.map((i) => i.label)).toEqual(['iPhone', 'Mac', 'Windows', 'Android'])
  })

  it('carries through a per-item icon id unresolved -- validation happens at render time via resolveTemplateIconId, not here', () => {
    const scene = baseScene({
      templateId: 'device-compatibility-lineup',
      content: { items: [{ id: 'a', label: 'One', iconId: 'not-a-real-icon' as never }] }
    })
    expect(deriveDeviceItems(scene)[0].iconId).toBe('not-a-real-icon')
  })
})

describe('resolveDeviceIconAndColor (safe icon fallback for the device lineup)', () => {
  it('uses the item\'s own color and icon when both are valid', () => {
    const result = resolveDeviceIconAndColor({ id: 'a', label: 'iPhone', iconId: 'security', color: '#ff0000' }, 0, '#000000')
    expect(result).toEqual({ color: '#ff0000', iconId: 'security' })
  })

  it('falls back to the slot\'s default device icon (never blank) when the stored icon id is unknown/corrupted', () => {
    const result = resolveDeviceIconAndColor({ id: 'a', label: 'iPhone', iconId: 'not-a-real-icon' as never }, 0, '#000000')
    expect(result.iconId).toBe('device') // slot 0's default (iPhone)
  })

  it('falls back to the slot\'s default color when the item has none', () => {
    const result = resolveDeviceIconAndColor({ id: 'a', label: 'Mac' }, 1, '#000000')
    expect(result.color).toBe('#ff9d42') // slot 1's default (Mac -- orange)
  })

  it('never throws for any index, wrapping around the 4 default slots', () => {
    for (let i = 0; i < 10; i++) {
      expect(() => resolveDeviceIconAndColor({ id: 'x', label: 'Device' }, i, '#000000')).not.toThrow()
    }
  })
})
