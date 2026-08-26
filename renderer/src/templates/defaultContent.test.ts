import { describe, it, expect } from 'vitest'
import { defaultContentForTemplate } from './defaultContent'
import { TEMPLATE_IDS } from '@shared/templates'

const TEMPLATES_WITH_STARTER_CONTENT = [
  'tech-title-scene',
  'three-step-presenter-plan',
  'device-compatibility-lineup',
  'social-channel-card',
  'security-login-flow',
  'feature-benefits-pills',
  'cause-effect-flow',
  'isometric-system-diagram',
  'vault-break-in-animation',
  'animated-break-in-vault-diagram',
  'data-center-cyber-intrusion',
  'hospital-emergency-response'
]
const TEMPLATES_WITHOUT_STARTER_CONTENT = TEMPLATE_IDS.filter((id) => !TEMPLATES_WITH_STARTER_CONTENT.includes(id))

describe('defaultContentForTemplate', () => {
  it('is undefined for every template that declares no starter content -- purely additive, no behavior change for old scenes', () => {
    expect(TEMPLATES_WITHOUT_STARTER_CONTENT).toHaveLength(16)
    for (const id of TEMPLATES_WITHOUT_STARTER_CONTENT) {
      expect(defaultContentForTemplate(id, 'seed')).toBeUndefined()
    }
  })

  it('provides composed starter content (never "New text") for every template that declares it', () => {
    for (const id of TEMPLATES_WITH_STARTER_CONTENT) {
      const defaults = defaultContentForTemplate(id as never, 'seed')
      expect(defaults).toBeDefined()
      expect(defaults!.visualText).not.toBe('New text')
      expect(defaults!.visualText.length).toBeGreaterThan(0)
    }
  })

  it('provides composed starter content for the three cinematic templates instead of a generic "New text"', () => {
    const tech = defaultContentForTemplate('tech-title-scene', 'seed')!
    expect(tech.visualText).not.toBe('New text')
    expect(tech.content?.eyebrow).toBeTruthy()
    expect(tech.content?.title).toBeTruthy()
    expect(tech.presentationMode).toBe('full-frame')
    expect(tech.background?.glowColor).toBeTruthy() // mode is left unset so the template's own gradient-overlay default applies

    const steps = defaultContentForTemplate('three-step-presenter-plan', 'seed')!
    expect(steps.content?.items).toHaveLength(3)
    expect(steps.presentationMode).toBe('presenter-overlay')

    const devices = defaultContentForTemplate('device-compatibility-lineup', 'seed')!
    expect(devices.content?.items).toHaveLength(4)
    expect(devices.presentationMode).toBe('full-frame')
  })

  it('provides professional starter content for the five new batch-2 templates', () => {
    const social = defaultContentForTemplate('social-channel-card', 'seed')!
    expect(social.content?.items).toHaveLength(3)
    expect(social.presentationMode).toBe('presenter-overlay')

    const login = defaultContentForTemplate('security-login-flow', 'seed')!
    expect(login.content?.items).toHaveLength(3)
    expect(login.content?.items?.map((i) => i.status)).toEqual(['complete', 'warning', 'blocked'])

    const benefits = defaultContentForTemplate('feature-benefits-pills', 'seed')!
    expect(benefits.content?.items?.length).toBeGreaterThanOrEqual(3)

    const flow = defaultContentForTemplate('cause-effect-flow', 'seed')!
    expect(flow.content?.items).toHaveLength(2)
    expect(flow.content?.items?.[0].value).toBe('CAUSE')
    expect(flow.content?.items?.[1].value).toBe('EFFECT')

    const iso = defaultContentForTemplate('isometric-system-diagram', 'seed')!
    expect(iso.content?.items).toHaveLength(3)
    expect(iso.content?.items?.some((i) => i.status === 'warning')).toBe(true)
  })

  it('derives item ids deterministically from the given seed, never random', () => {
    const a = defaultContentForTemplate('three-step-presenter-plan', 'scene-123')!
    const b = defaultContentForTemplate('three-step-presenter-plan', 'scene-123')!
    expect(a.content?.items?.map((i) => i.id)).toEqual(b.content?.items?.map((i) => i.id))
    expect(a.content?.items?.[0].id).toBe('scene-123-0')
  })
})
