import { describe, expect, it } from 'vitest'
import { storyBeatToScene } from './storyBeatToScene'
import type { StoryBeat, NarrativeEntity, NarrativeRelation, StoryVisualTheme } from '@shared/story'

const THEME: StoryVisualTheme = {
  entityColors: { 'entity-wang-lin': '#5b8cff', 'entity-lu-mo': '#b45bff' },
  characterAssets: {},
  lineStyle: 'solid',
  lineWidth: 2,
  glowIntensity: 50,
  backgroundMode: 'transparent',
  animationIntensity: 50,
  khmerFont: 'Noto Sans Khmer',
  latinFont: 'Segoe UI'
}

function wangLin(overrides: Partial<NarrativeEntity> = {}): NarrativeEntity {
  return {
    id: 'entity-wang-lin',
    type: 'character',
    canonicalName: 'Wang Lin',
    aliases: [],
    description: 'The central character.',
    firstSegmentId: 'seg-1',
    color: '#111111',
    ...overrides
  }
}

function luMo(overrides: Partial<NarrativeEntity> = {}): NarrativeEntity {
  return {
    id: 'entity-lu-mo',
    type: 'character',
    canonicalName: 'Lu Mo',
    aliases: [],
    description: 'Created from Wang Lin.',
    firstSegmentId: 'seg-2',
    color: '#222222',
    ...overrides
  }
}

function beat(overrides: Partial<StoryBeat> = {}): StoryBeat {
  return {
    id: 'beat-1',
    startTime: 4,
    endTime: 12,
    segmentIds: ['seg-1', 'seg-2'],
    title: 'Wang Lin Is Real',
    summary: 'Wang Lin confirms his own identity.',
    purpose: 'establishes the central question',
    entities: ['entity-wang-lin'],
    relations: [],
    recommendedVisualization: 'central-identity',
    importance: 'critical',
    ...overrides
  }
}

const entitiesById = new Map([
  ['entity-wang-lin', wangLin()],
  ['entity-lu-mo', luMo()]
])
const relation: NarrativeRelation = {
  id: 'rel-1',
  fromEntityId: 'entity-wang-lin',
  toEntityId: 'entity-lu-mo',
  type: 'created_from',
  label: 'Lu Mo separates from Wang Lin',
  segmentIds: ['seg-2']
}
const relationsById = new Map([['rel-1', relation]])

describe('storyBeatToScene', () => {
  it('carries startTime/endTime/mediaId/track through unchanged', () => {
    const scene = storyBeatToScene(beat({ startTime: 4, endTime: 12 }), 'media-1', 'V3', THEME, entitiesById, relationsById)
    expect(scene.startTime).toBe(4)
    expect(scene.endTime).toBe(12)
    expect(scene.mediaId).toBe('media-1')
    expect(scene.track).toBe('V3')
  })

  it('maps recommendedVisualization directly onto templateId', () => {
    const scene = storyBeatToScene(beat({ recommendedVisualization: 'source-branch' }), 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.templateId).toBe('source-branch')
  })

  it('bakes the theme entity color into fillColor for central-identity, overriding the entity\'s own stored color', () => {
    const scene = storyBeatToScene(beat({ recommendedVisualization: 'central-identity', entities: ['entity-wang-lin'] }), 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.fillColor).toBe('#5b8cff') // theme color, not wangLin().color '#111111'
  })

  it('falls back to the entity\'s own color when the theme has no override for it', () => {
    const noOverrideTheme: StoryVisualTheme = { ...THEME, entityColors: {} }
    const scene = storyBeatToScene(beat({ recommendedVisualization: 'central-identity' }), 'm1', 'V2', noOverrideTheme, entitiesById, relationsById)
    expect(scene.fillColor).toBe('#111111')
  })

  it('central-identity: uses the primary entity name as title, not the beat title', () => {
    const scene = storyBeatToScene(beat({ recommendedVisualization: 'central-identity', entities: ['entity-wang-lin'] }), 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.title).toBe('Wang Lin')
  })

  it('source-branch: populates two items from resolved entities and the relation label as the value', () => {
    const b = beat({ recommendedVisualization: 'source-branch', entities: ['entity-wang-lin', 'entity-lu-mo'], relations: ['rel-1'] })
    const scene = storyBeatToScene(b, 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.items).toHaveLength(2)
    expect(scene.content?.items?.[0].label).toBe('Wang Lin')
    expect(scene.content?.items?.[1].label).toBe('Lu Mo')
    expect(scene.content?.value).toBe('Lu Mo separates from Wang Lin')
  })

  it('source-branch: items carry theme-resolved colors for both entities', () => {
    const b = beat({ recommendedVisualization: 'source-branch', entities: ['entity-wang-lin', 'entity-lu-mo'], relations: ['rel-1'] })
    const scene = storyBeatToScene(b, 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.items?.[0].color).toBe('#5b8cff')
    expect(scene.content?.items?.[1].color).toBe('#b45bff')
  })

  it('final-summary: derives node points from relation labels first, then fills remaining slots from entities', () => {
    const b = beat({ recommendedVisualization: 'final-summary', entities: ['entity-wang-lin', 'entity-lu-mo'], relations: ['rel-1'] })
    const scene = storyBeatToScene(b, 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.items).toHaveLength(3)
    expect(scene.content?.items?.[0].label).toBe('Lu Mo separates from Wang Lin')
  })

  it('chapter-evidence: uses the first evidence string as the eyebrow marker', () => {
    const b = beat({ recommendedVisualization: 'chapter-evidence', evidence: ['Chapter 2086'], entities: ['entity-wang-lin'] })
    const scene = storyBeatToScene(b, 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.eyebrow).toBe('Chapter 2086')
    expect(scene.content?.value).toBe('Evidence')
  })

  it('never invents evidence text -- eyebrow is undefined when the beat has none', () => {
    const b = beat({ recommendedVisualization: 'chapter-evidence', evidence: undefined })
    const scene = storyBeatToScene(b, 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.eyebrow).toBeUndefined()
  })

  it('drops entity ids that no longer resolve in the Entity Bible rather than crashing', () => {
    const b = beat({ entities: ['entity-wang-lin', 'entity-does-not-exist'] })
    const scene = storyBeatToScene(b, 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(scene.content?.title).toBe('Wang Lin')
  })

  it('gives every generated scene a distinct id and a story-prefixed suggestionId (never mistaken for a cloud/local-ai suggestion)', () => {
    const a = storyBeatToScene(beat({ id: 'beat-a' }), 'm1', 'V2', THEME, entitiesById, relationsById)
    const b = storyBeatToScene(beat({ id: 'beat-b' }), 'm1', 'V2', THEME, entitiesById, relationsById)
    expect(a.id).not.toBe(b.id)
    expect(a.suggestionId.startsWith('story-')).toBe(true)
  })

  it('maps every visualization family to a valid CommunicationPurpose', () => {
    const families: StoryBeat['recommendedVisualization'][] = ['central-identity', 'reality-vs-dream', 'body-vs-avatar', 'source-branch', 'chapter-evidence', 'final-summary']
    for (const recommendedVisualization of families) {
      const scene = storyBeatToScene(beat({ recommendedVisualization }), 'm1', 'V2', THEME, entitiesById, relationsById)
      expect(typeof scene.purpose).toBe('string')
      expect(scene.purpose.length).toBeGreaterThan(0)
    }
  })
})
