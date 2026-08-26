import { describe, it, expect } from 'vitest'
import { resolveTemplateIconId, TEMPLATE_ICON_IDS } from './templateIcons'

describe('resolveTemplateIconId', () => {
  it('resolves every registered icon id to itself', () => {
    for (const id of TEMPLATE_ICON_IDS) {
      expect(resolveTemplateIconId(id)).toBe(id)
    }
  })

  it('returns null (never throws) for an unknown or stale icon id', () => {
    expect(resolveTemplateIconId('not-a-real-icon')).toBeNull()
    expect(resolveTemplateIconId('legacy-icon-from-an-old-build')).toBeNull()
  })

  it('returns null for undefined/null/empty input instead of crashing the renderer', () => {
    expect(resolveTemplateIconId(undefined)).toBeNull()
    expect(resolveTemplateIconId(null)).toBeNull()
    expect(resolveTemplateIconId('')).toBeNull()
  })

  it('includes the four new categories added for the cinematic templates', () => {
    expect(TEMPLATE_ICON_IDS).toEqual(expect.arrayContaining(['message', 'calendar', 'briefcase', 'chip']))
  })
})
