import { describe, it, expect } from 'vitest'
import { matchSettingsCategories, SETTINGS_CATEGORIES } from './settingsSections'

describe('matchSettingsCategories', () => {
  it('returns everything for a blank query', () => {
    expect(matchSettingsCategories('')).toHaveLength(SETTINGS_CATEGORIES.length)
    expect(matchSettingsCategories('   ')).toHaveLength(SETTINGS_CATEGORIES.length)
  })

  it('matches a category by its visible label', () => {
    expect(matchSettingsCategories('appearance').map((c) => c.id)).toEqual(['appearance'])
  })

  it('matches on keywords people actually type, not just the heading', () => {
    expect(matchSettingsCategories('dark').map((c) => c.id)).toEqual(['appearance'])
    expect(matchSettingsCategories('gpu').map((c) => c.id)).toEqual(['voice'])
    expect(matchSettingsCategories('voxcpm').map((c) => c.id)).toEqual(['voice'])
  })

  it('is case-insensitive', () => {
    expect(matchSettingsCategories('CUDA').map((c) => c.id)).toEqual(['voice'])
  })

  it('narrows on multiple terms rather than widening', () => {
    expect(matchSettingsCategories('voice gpu').map((c) => c.id)).toEqual(['voice'])
    expect(matchSettingsCategories('voice dark')).toEqual([])
  })

  it('returns nothing for a term no category knows', () => {
    expect(matchSettingsCategories('bluetooth')).toEqual([])
  })
})
