import { describe, expect, it } from 'vitest'
import { buildDefaultStoryTheme, mergeEntitiesIntoTheme, setThemeEntityColor } from './storyTheme'
import type { NarrativeEntity } from '@shared/story'

function entity(overrides: Partial<NarrativeEntity> = {}): NarrativeEntity {
  return {
    id: 'entity-wang-lin',
    type: 'character',
    canonicalName: 'Wang Lin',
    aliases: [],
    description: 'desc',
    firstSegmentId: 'seg-1',
    color: '#5b8cff',
    ...overrides
  }
}

describe('buildDefaultStoryTheme', () => {
  it('seeds entityColors from each entity\'s own color', () => {
    const theme = buildDefaultStoryTheme([entity(), entity({ id: 'entity-lu-mo', color: '#b45bff' })])
    expect(theme.entityColors).toEqual({ 'entity-wang-lin': '#5b8cff', 'entity-lu-mo': '#b45bff' })
  })

  it('produces a theme with sensible non-empty defaults for every field', () => {
    const theme = buildDefaultStoryTheme([])
    expect(theme.lineWidth).toBeGreaterThan(0)
    expect(theme.khmerFont.length).toBeGreaterThan(0)
    expect(theme.latinFont.length).toBeGreaterThan(0)
  })
})

describe('mergeEntitiesIntoTheme', () => {
  it('adds colors for new entities without touching existing ones', () => {
    const theme = buildDefaultStoryTheme([entity({ color: '#5b8cff' })])
    const customized = setThemeEntityColor(theme, 'entity-wang-lin', '#ff0000')
    const merged = mergeEntitiesIntoTheme(customized, [entity({ color: '#5b8cff' }), entity({ id: 'entity-lu-mo', color: '#b45bff' })])
    expect(merged.entityColors['entity-wang-lin']).toBe('#ff0000') // untouched
    expect(merged.entityColors['entity-lu-mo']).toBe('#b45bff') // newly added
  })

  it('returns the same reference when nothing changes', () => {
    const theme = buildDefaultStoryTheme([entity()])
    const merged = mergeEntitiesIntoTheme(theme, [entity()])
    expect(merged).toBe(theme)
  })
})

describe('setThemeEntityColor', () => {
  it('overrides one entity color without touching others', () => {
    const theme = buildDefaultStoryTheme([entity(), entity({ id: 'entity-lu-mo', color: '#b45bff' })])
    const next = setThemeEntityColor(theme, 'entity-wang-lin', '#00ff00')
    expect(next.entityColors['entity-wang-lin']).toBe('#00ff00')
    expect(next.entityColors['entity-lu-mo']).toBe('#b45bff')
  })
})
