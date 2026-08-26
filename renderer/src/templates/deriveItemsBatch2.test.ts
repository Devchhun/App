import { describe, it, expect } from 'vitest'
import { deriveSocialItems } from './SocialChannelCard'
import { deriveLoginRows } from './SecurityLoginFlow'
import { deriveBenefitItems } from './FeatureBenefitsPills'
import { deriveFlowNodes } from './CauseEffectFlow'
import { deriveIsometricNodes } from './IsometricSystemDiagram'
import type { Scene } from '@shared/project'

function baseScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    mediaId: 'm1',
    segmentId: 'seg1',
    suggestionId: 'sug1',
    track: 'V2',
    templateId: 'social-channel-card',
    startTime: 0,
    endTime: 4,
    purpose: 'person',
    originalText: '',
    visualText: 'Sokha Dara',
    reason: '',
    confidence: 1,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date(0).toISOString(),
    ...overrides
  }
}

describe('deriveSocialItems', () => {
  it('uses explicit content.items when present', () => {
    const scene = baseScene({ content: { items: [{ id: 'a', label: '@one' }] } })
    expect(deriveSocialItems(scene).map((i) => i.label)).toEqual(['@one'])
  })

  it('falls back to default social rows for an old/untouched scene', () => {
    const scene = baseScene({ content: undefined })
    const items = deriveSocialItems(scene)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.label.length > 0)).toBe(true)
  })

  it('is deterministic', () => {
    const scene = baseScene({ content: undefined })
    expect(deriveSocialItems(scene)).toEqual(deriveSocialItems(scene))
  })
})

describe('deriveLoginRows', () => {
  it('defaults to exactly 3 rows with distinct statuses (complete/warning/blocked)', () => {
    const scene = baseScene({ templateId: 'security-login-flow', content: undefined })
    const rows = deriveLoginRows(scene)
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.status)).size).toBeGreaterThan(1)
  })

  it('caps explicit content.items at 3', () => {
    const scene = baseScene({
      templateId: 'security-login-flow',
      content: { items: [{ id: 'a', label: '1' }, { id: 'b', label: '2' }, { id: 'c', label: '3' }, { id: 'd', label: '4' }] }
    })
    expect(deriveLoginRows(scene)).toHaveLength(3)
  })

  it('preserves a custom status set by the user', () => {
    const scene = baseScene({
      templateId: 'security-login-flow',
      content: { items: [{ id: 'a', label: 'Password', status: 'blocked' }] }
    })
    expect(deriveLoginRows(scene)[0].status).toBe('blocked')
  })
})

describe('deriveBenefitItems', () => {
  it('defaults to at least 3 pills for an untouched scene', () => {
    const scene = baseScene({ templateId: 'feature-benefits-pills', content: undefined })
    expect(deriveBenefitItems(scene).length).toBeGreaterThanOrEqual(3)
  })

  it('caps at 4 pills even if more are stored', () => {
    const scene = baseScene({
      templateId: 'feature-benefits-pills',
      content: { items: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, label: `Pill ${n}` })) }
    })
    expect(deriveBenefitItems(scene)).toHaveLength(4)
  })
})

describe('deriveFlowNodes', () => {
  it('defaults to a cause and an effect node', () => {
    const scene = baseScene({ templateId: 'cause-effect-flow', content: undefined })
    const nodes = deriveFlowNodes(scene)
    expect(nodes).toHaveLength(2)
    expect(nodes[0].value).toBe('CAUSE')
    expect(nodes[1].value).toBe('EFFECT')
  })

  it('supports up to 2 additional supporting nodes (4 total)', () => {
    const scene = baseScene({
      templateId: 'cause-effect-flow',
      content: { items: [{ id: 'a', label: 'Cause' }, { id: 'b', label: 'Effect' }, { id: 'c', label: 'Support 1' }, { id: 'd', label: 'Support 2' }] }
    })
    expect(deriveFlowNodes(scene)).toHaveLength(4)
  })
})

describe('deriveIsometricNodes', () => {
  it('defaults to exactly 3 layer nodes, one flagged as a warning', () => {
    const scene = baseScene({ templateId: 'isometric-system-diagram', content: undefined })
    const nodes = deriveIsometricNodes(scene)
    expect(nodes).toHaveLength(3)
    expect(nodes.some((n) => n.status === 'warning')).toBe(true)
  })

  it('preserves user-edited node labels and order', () => {
    const scene = baseScene({
      templateId: 'isometric-system-diagram',
      content: { items: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'Gateway' }, { id: 'c', label: 'Database' }] }
    })
    expect(deriveIsometricNodes(scene).map((n) => n.label)).toEqual(['Client', 'Gateway', 'Database'])
  })
})
