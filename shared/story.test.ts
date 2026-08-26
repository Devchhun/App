import { describe, expect, it } from 'vitest'
import { validateNarrativeGraph, STORY_LIMITS, buildNarrativeGraphResponseJsonSchema } from './story'

const SEGMENT_IDS = new Set(['seg-1', 'seg-2', 'seg-3', 'seg-4'])
const MEDIA_DURATION = 600

function baseContext() {
  return { segmentIds: SEGMENT_IDS, mediaDurationSeconds: MEDIA_DURATION }
}

function wangLinEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entity-wang-lin',
    type: 'character',
    canonicalName: 'Wang Lin',
    aliases: ['Wang Lin'],
    description: 'The central character.',
    firstSegmentId: 'seg-1',
    color: '#5b8cff',
    ...overrides
  }
}

function luMoEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entity-lu-mo',
    type: 'character',
    canonicalName: 'Lu Mo',
    aliases: ['Slaughter Essence Body'],
    description: 'Created from Wang Lin near the end of the story.',
    firstSegmentId: 'seg-2',
    color: '#b45bff',
    ...overrides
  }
}

function beat(overrides: Record<string, unknown> = {}) {
  return {
    id: 'beat-1',
    startTime: 0,
    endTime: 5,
    segmentIds: ['seg-1'],
    title: 'Opening Question',
    summary: 'Is Wang Lin real?',
    purpose: 'question',
    entities: ['entity-wang-lin'],
    relations: [],
    recommendedVisualization: 'central-identity',
    importance: 'critical',
    ...overrides
  }
}

function graph(overrides: Record<string, unknown> = {}) {
  return {
    entities: [wangLinEntity()],
    relations: [],
    beats: [beat()],
    chronology: ['beat-1'],
    centralQuestion: 'Is Wang Lin real?',
    finalConclusion: 'Wang Lin is real; Lu Mo performed the simulations.',
    ...overrides
  }
}

describe('validateNarrativeGraph -- happy path', () => {
  it('accepts a minimal valid graph', () => {
    const result = validateNarrativeGraph(graph(), baseContext())
    expect(result.ok).toBe(true)
    expect(result.graph?.entities).toHaveLength(1)
    expect(result.graph?.beats).toHaveLength(1)
    expect(result.rejectedItems).toHaveLength(0)
    expect(result.envelopeError).toBeNull()
  })

  it('accepts a same_identity relation distinguishing Original Body / Cultivation Avatar as one identity', () => {
    const g = graph({
      entities: [
        wangLinEntity(),
        wangLinEntity({ id: 'entity-original-body', canonicalName: 'Original Body', color: '#18d77b' }),
        wangLinEntity({ id: 'entity-cultivation-avatar', canonicalName: 'Cultivation Avatar', color: '#ffb020' })
      ],
      relations: [
        {
          id: 'rel-1',
          fromEntityId: 'entity-original-body',
          toEntityId: 'entity-cultivation-avatar',
          type: 'same_identity',
          label: 'Both are Wang Lin',
          segmentIds: ['seg-1']
        }
      ],
      beats: [beat({ entities: ['entity-wang-lin', 'entity-original-body', 'entity-cultivation-avatar'], relations: ['rel-1'], recommendedVisualization: 'body-vs-avatar' })]
    })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.ok).toBe(true)
    expect(result.graph?.relations[0].type).toBe('same_identity')
  })

  it('accepts a created_from relation mapping Lu Mo as created from Wang Lin, not the original', () => {
    const g = graph({
      entities: [wangLinEntity(), luMoEntity()],
      relations: [
        {
          id: 'rel-lu-mo',
          fromEntityId: 'entity-wang-lin',
          toEntityId: 'entity-lu-mo',
          type: 'created_from',
          label: 'Lu Mo separates from Wang Lin',
          segmentIds: ['seg-2']
        }
      ],
      beats: [beat({ id: 'beat-2', startTime: 5, endTime: 10, segmentIds: ['seg-2'], entities: ['entity-wang-lin', 'entity-lu-mo'], relations: ['rel-lu-mo'], recommendedVisualization: 'source-branch' })],
      chronology: ['beat-2']
    })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.ok).toBe(true)
    expect(result.graph?.relations[0].fromEntityId).toBe('entity-wang-lin')
    expect(result.graph?.relations[0].type).toBe('created_from')
    // Lu Mo is NOT flagged same_identity with Wang Lin -- created_from is a distinct, related-but-not-equal relation.
    expect(result.graph?.relations[0].type).not.toBe('same_identity')
  })
})

describe('validateNarrativeGraph -- rejection and dropping', () => {
  it('rejects the whole envelope on malformed top-level shape', () => {
    const result = validateNarrativeGraph({ entities: 'not-an-array' }, baseContext())
    expect(result.ok).toBe(false)
    expect(result.graph).toBeNull()
    expect(result.envelopeError).not.toBeNull()
  })

  it('drops an individual entity with an unknown type but keeps the rest of the graph', () => {
    const g = graph({ entities: [wangLinEntity(), wangLinEntity({ id: 'entity-bad', type: 'not-a-real-type' })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.entities).toHaveLength(1)
    expect(result.rejectedItems).toContainEqual(expect.objectContaining({ kind: 'entity' }))
  })

  it('drops an entity referencing a firstSegmentId not in the real transcript', () => {
    const g = graph({ entities: [wangLinEntity({ firstSegmentId: 'seg-does-not-exist' })], beats: [beat({ entities: [] })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.entities).toHaveLength(0)
    expect(result.rejectedItems.some((r) => r.kind === 'entity' && r.reason.includes('firstSegmentId'))).toBe(true)
  })

  it('drops a relation referencing a nonexistent entity id', () => {
    const g = graph({
      entities: [wangLinEntity()],
      relations: [{ id: 'rel-bad', fromEntityId: 'entity-wang-lin', toEntityId: 'entity-ghost', type: 'caused', label: 'x', segmentIds: [] }]
    })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.relations).toHaveLength(0)
    expect(result.rejectedItems.some((r) => r.kind === 'relation')).toBe(true)
  })

  it('drops a beat referencing an orphaned entity id (entity was itself dropped)', () => {
    const g = graph({
      entities: [wangLinEntity({ firstSegmentId: 'seg-does-not-exist' })],
      beats: [beat({ entities: ['entity-wang-lin'] })]
    })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.beats).toHaveLength(0)
    expect(result.rejectedItems.some((r) => r.kind === 'beat' && r.reason.includes('entity id'))).toBe(true)
  })

  it('drops a beat referencing an orphaned relation id', () => {
    const g = graph({ beats: [beat({ relations: ['rel-does-not-exist'] })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.beats).toHaveLength(0)
    expect(result.rejectedItems.some((r) => r.kind === 'beat' && r.reason.includes('relation id'))).toBe(true)
  })

  it('drops a beat whose endTime exceeds the media duration', () => {
    const g = graph({ beats: [beat({ endTime: MEDIA_DURATION + 100 })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.beats).toHaveLength(0)
  })

  it('drops a beat where endTime is not after startTime', () => {
    const g = graph({ beats: [beat({ startTime: 5, endTime: 5 })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.beats).toHaveLength(0)
  })

  it('rejects entity text containing unsafe markup', () => {
    const g = graph({ entities: [wangLinEntity({ description: '<script>alert(1)</script>' })], beats: [beat({ entities: [] })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.entities).toHaveLength(0)
    expect(result.rejectedItems.some((r) => r.reason.includes('markup'))).toBe(true)
  })

  it('rejects beat text containing unsafe markup', () => {
    const g = graph({ beats: [beat({ summary: 'javascript:alert(1)' })] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.beats).toHaveLength(0)
  })

  it('rejects the whole envelope when centralQuestion contains unsafe markup', () => {
    const g = graph({ centralQuestion: '<iframe src="evil"></iframe>' })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.ok).toBe(false)
    expect(result.graph).toBeNull()
  })

  it('filters chronology down to only valid, surviving beat ids', () => {
    const g = graph({ chronology: ['beat-1', 'beat-does-not-exist'] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.chronology).toEqual(['beat-1'])
  })

  it('drops duplicate entity ids, keeping only the first', () => {
    const g = graph({ entities: [wangLinEntity(), wangLinEntity()] })
    const result = validateNarrativeGraph(g, baseContext())
    expect(result.graph?.entities).toHaveLength(1)
    expect(result.rejectedItems.some((r) => r.reason.includes('duplicate'))).toBe(true)
  })

  it('is not ok when there are zero entities or zero beats even if envelope parses', () => {
    const result = validateNarrativeGraph(graph({ entities: [], beats: [] }), baseContext())
    expect(result.ok).toBe(false)
    expect(result.graph).not.toBeNull()
    expect(result.envelopeError).toBeNull()
  })

  it('caps entities/relations/beats arrays at their hard limits', () => {
    const tooManyEntities = Array.from({ length: STORY_LIMITS.maxEntities + 5 }, (_, i) => wangLinEntity({ id: `entity-${i}` }))
    const result = validateNarrativeGraph(graph({ entities: tooManyEntities }), baseContext())
    expect(result.ok).toBe(false)
    expect(result.envelopeError).not.toBeNull()
  })
})

describe('buildNarrativeGraphResponseJsonSchema', () => {
  it('produces a JSON schema object with the top-level graph fields', () => {
    const schema = buildNarrativeGraphResponseJsonSchema() as { properties?: Record<string, unknown> }
    expect(schema.properties).toBeDefined()
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['entities', 'relations', 'beats', 'chronology', 'centralQuestion', 'finalConclusion'])
    )
  })
})
