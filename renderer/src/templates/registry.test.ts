import { describe, it, expect } from 'vitest'
import { getTemplate, listAllTemplates, listTemplatesByCategory, listTemplatesByPurpose, searchTemplates, TEMPLATE_REGISTRY } from './registry'
import {
  TEMPLATE_IDS,
  TEMPLATE_ICON_SUPPORT,
  TEMPLATE_CONTENT_SLOTS,
  TEMPLATE_ITEM_COUNT,
  TEMPLATE_RECOMMENDATIONS,
  DEFAULT_TEMPLATE_FOR_PURPOSE,
  getEffectivePresentationMode,
  getSupportedPresentationModes
} from '@shared/templates'

describe('template registry', () => {
  it('registers every declared TemplateId exactly once', () => {
    const all = listAllTemplates()
    expect(all).toHaveLength(TEMPLATE_IDS.length)
    expect(new Set(all.map((t) => t.id)).size).toBe(TEMPLATE_IDS.length)
  })

  it('getTemplate finds a definition by id with a real component', () => {
    const def = getTemplate('checklist')
    expect(def.id).toBe('checklist')
    expect(typeof def.component).toBe('function')
  })

  it('filters by category', () => {
    const warnings = listTemplatesByCategory('warnings')
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.every((t) => t.category === 'warnings')).toBe(true)
  })

  it('an unused category returns an empty list rather than throwing', () => {
    expect(listTemplatesByCategory('location')).toEqual([])
  })

  it('filters by AI purpose using the recommendation table', () => {
    const forWarning = listTemplatesByPurpose('warning')
    expect(forWarning.some((t) => t.id === 'warning-alert')).toBe(true)
  })

  it('searches by name, description, and tags case-insensitively', () => {
    expect(searchTemplates('checklist').some((t) => t.id === 'checklist')).toBe(true)
    expect(searchTemplates('PERCENT').some((t) => t.id === 'percentage-card')).toBe(true)
    expect(searchTemplates('nonexistent-term-xyz')).toHaveLength(0)
  })

  it('an empty search returns every template', () => {
    expect(searchTemplates('')).toHaveLength(TEMPLATE_IDS.length)
  })

  it('every template has at least one supported purpose', () => {
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATE_REGISTRY[id].supportedPurposes.length).toBeGreaterThan(0)
    }
  })

  describe('the three cinematic templates', () => {
    it('are registered with a real component, correct category, and icon support', () => {
      const techTitle = getTemplate('tech-title-scene')
      expect(techTitle.category).toBe('technology')
      expect(typeof techTitle.component).toBe('function')
      expect(TEMPLATE_ICON_SUPPORT['tech-title-scene']).toBe('single')

      const steps = getTemplate('three-step-presenter-plan')
      expect(steps.category).toBe('steps')
      expect(typeof steps.component).toBe('function')
      expect(TEMPLATE_ICON_SUPPORT['three-step-presenter-plan']).toBe('per-item')

      const devices = getTemplate('device-compatibility-lineup')
      expect(devices.category).toBe('technology')
      expect(typeof devices.component).toBe('function')
      expect(TEMPLATE_ICON_SUPPORT['device-compatibility-lineup']).toBe('per-item')
    })

    it('declare structured content slots the Properties panel can render conditionally', () => {
      expect(TEMPLATE_CONTENT_SLOTS['tech-title-scene']).toEqual(expect.arrayContaining(['eyebrow', 'title', 'value', 'background']))
      expect(TEMPLATE_CONTENT_SLOTS['three-step-presenter-plan']).toEqual(expect.arrayContaining(['eyebrow', 'items', 'presentationMode']))
      expect(TEMPLATE_CONTENT_SLOTS['device-compatibility-lineup']).toEqual(expect.arrayContaining(['title', 'items', 'cta', 'background']))
      // The original 10 templates are untouched -- purely additive.
      expect(TEMPLATE_CONTENT_SLOTS['lower-third']).toBeUndefined()
      expect(TEMPLATE_CONTENT_SLOTS.checklist).toBeUndefined()
    })

    it('declare a fixed item count matching their name (three steps, four devices)', () => {
      expect(TEMPLATE_ITEM_COUNT['three-step-presenter-plan']).toBe(3)
      expect(TEMPLATE_ITEM_COUNT['device-compatibility-lineup']).toBe(4)
    })

    it('are findable via category listing and search', () => {
      expect(listTemplatesByCategory('technology').map((t) => t.id)).toEqual(
        expect.arrayContaining(['tech-title-scene', 'device-compatibility-lineup'])
      )
      expect(searchTemplates('cyber').some((t) => t.id === 'tech-title-scene')).toBe(true)
      expect(searchTemplates('device').some((t) => t.id === 'device-compatibility-lineup')).toBe(true)
      expect(searchTemplates('presenter').some((t) => t.id === 'three-step-presenter-plan')).toBe(true)
    })
  })

  describe('the five batch-2 templates', () => {
    const NEW_IDS = [
      'social-channel-card',
      'security-login-flow',
      'feature-benefits-pills',
      'cause-effect-flow',
      'isometric-system-diagram'
    ] as const

    it('are all registered with a real component and a non-empty description', () => {
      for (const id of NEW_IDS) {
        const def = getTemplate(id)
        expect(def.id).toBe(id)
        expect(typeof def.component).toBe('function')
        expect(def.description.length).toBeGreaterThan(0)
      }
    })

    it('all declare per-item icon support and a fixed item count', () => {
      for (const id of NEW_IDS) {
        expect(TEMPLATE_ICON_SUPPORT[id]).toBe('per-item')
        expect(TEMPLATE_ITEM_COUNT[id]).toBeGreaterThan(0)
      }
    })

    it('all declare at least one structured content slot', () => {
      for (const id of NEW_IDS) {
        expect(TEMPLATE_CONTENT_SLOTS[id]?.length).toBeGreaterThan(0)
      }
    })

    it('Social Channel Card defaults to presenter-overlay and supports overlay as an alternative', () => {
      expect(getEffectivePresentationMode('social-channel-card')).toBe('presenter-overlay')
      expect(getSupportedPresentationModes('social-channel-card')).toEqual(['presenter-overlay', 'overlay'])
    })

    it('two of the remaining four default to plain overlay (no full-frame background is forced on them)', () => {
      for (const id of ['feature-benefits-pills', 'isometric-system-diagram'] as const) {
        expect(getEffectivePresentationMode(id)).toBe('overlay')
      }
    })

    it('Cause and Effect Flow / Security Login Flow default to full-frame so their foreground composition gets an independent, resizable content transform', () => {
      // Their background still defaults to transparent (see
      // SceneBackgroundLayer's defaultMode="transparent" in each template) --
      // "full-frame" here only means the coordinate space the foreground can
      // be positioned in, not an opaque background forced over the source
      // video. Without this, resizing the on-canvas selection box only
      // resized an outer box the template's fixed-size internals ignored.
      expect(getEffectivePresentationMode('cause-effect-flow')).toBe('full-frame')
      expect(getEffectivePresentationMode('security-login-flow')).toBe('full-frame')
      expect(getSupportedPresentationModes('cause-effect-flow')).toEqual(['full-frame', 'overlay'])
    })

    it('are each assigned a distinct, sensible category', () => {
      expect(getTemplate('social-channel-card').category).toBe('social')
      expect(getTemplate('security-login-flow').category).toBe('warnings')
      expect(getTemplate('feature-benefits-pills').category).toBe('information')
      expect(getTemplate('cause-effect-flow').category).toBe('comparisons')
      expect(getTemplate('isometric-system-diagram').category).toBe('diagrams')
    })

    it('are all findable by search on their own name', () => {
      for (const id of NEW_IDS) {
        expect(searchTemplates(getTemplate(id).name).some((t) => t.id === id)).toBe(true)
      }
    })
  })

  describe('purpose-to-template recommendation mapping', () => {
    it('recommends the cinematic templates for their strongly-matched purposes', () => {
      expect(TEMPLATE_RECOMMENDATIONS.device).toContain('device-compatibility-lineup')
      expect(TEMPLATE_RECOMMENDATIONS.sequence_of_steps).toContain('three-step-presenter-plan')
      expect(TEMPLATE_RECOMMENDATIONS.cybersecurity_event).toContain('tech-title-scene')
      expect(TEMPLATE_RECOMMENDATIONS.warning).toContain('tech-title-scene')
    })

    it('sets the new templates as the primary default only where the match is unambiguous', () => {
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.device).toBe('device-compatibility-lineup')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.sequence_of_steps).toBe('three-step-presenter-plan')
    })

    it('does not change the existing default for purposes where warning-alert/title-card already fit well', () => {
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.warning).toBe('warning-alert')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.introduction).toBe('title-card')
    })

    it('sets Security Login Flow as the primary default for cybersecurity_event (strong, explicit match)', () => {
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.cybersecurity_event).toBe('security-login-flow')
    })

    it('recommends the five new templates for their named purposes', () => {
      expect(TEMPLATE_RECOMMENDATIONS.person).toContain('social-channel-card')
      expect(TEMPLATE_RECOMMENDATIONS.organization).toContain('social-channel-card')
      expect(TEMPLATE_RECOMMENDATIONS.call_to_action).toContain('social-channel-card')
      expect(TEMPLATE_RECOMMENDATIONS.cybersecurity_event).toContain('security-login-flow')
      expect(TEMPLATE_RECOMMENDATIONS.warning).toContain('security-login-flow')
      expect(TEMPLATE_RECOMMENDATIONS.sequence_of_steps).toContain('security-login-flow')
      expect(TEMPLATE_RECOMMENDATIONS.list).toContain('feature-benefits-pills')
      expect(TEMPLATE_RECOMMENDATIONS.product).toContain('feature-benefits-pills')
      expect(TEMPLATE_RECOMMENDATIONS.main_claim).toContain('feature-benefits-pills')
      expect(TEMPLATE_RECOMMENDATIONS.conclusion).toContain('feature-benefits-pills')
    })

    it('every recommendation list still references a registered template id', () => {
      for (const ids of Object.values(TEMPLATE_RECOMMENDATIONS)) {
        for (const id of ids) {
          expect(TEMPLATE_IDS).toContain(id)
        }
      }
    })
  })

  describe('Vault Break-In Animation', () => {
    it('is registered with a real component, name, and description', () => {
      const def = getTemplate('vault-break-in-animation')
      expect(def.name).toBe('Vault Break-In Animation')
      expect(typeof def.component).toBe('function')
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.category).toBe('diagrams')
    })

    it('defaults to full-frame so its foreground composition gets an independent, resizable content transform', () => {
      expect(getEffectivePresentationMode('vault-break-in-animation')).toBe('full-frame')
      expect(getSupportedPresentationModes('vault-break-in-animation')).toEqual(['full-frame', 'overlay'])
    })

    it('is recommended (without displacing the existing strong default) for cybersecurity event, warning, security breach, technical process, and sequence of steps', () => {
      expect(TEMPLATE_RECOMMENDATIONS.cybersecurity_event).toContain('vault-break-in-animation')
      expect(TEMPLATE_RECOMMENDATIONS.warning).toContain('vault-break-in-animation')
      expect(TEMPLATE_RECOMMENDATIONS.problem).toContain('vault-break-in-animation') // closest match to "security breach" beyond cybersecurity_event
      expect(TEMPLATE_RECOMMENDATIONS.solution).toContain('vault-break-in-animation') // closest match to "technical process"
      expect(TEMPLATE_RECOMMENDATIONS.sequence_of_steps).toContain('vault-break-in-animation')
      // The existing, already-strong defaults are untouched by adding this new recommendation.
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.cybersecurity_event).toBe('security-login-flow')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.warning).toBe('warning-alert')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.sequence_of_steps).toBe('three-step-presenter-plan')
    })

    it('is findable by search on its own name and tags', () => {
      expect(searchTemplates('Vault Break-In Animation').some((t) => t.id === 'vault-break-in-animation')).toBe(true)
      expect(searchTemplates('heist').some((t) => t.id === 'vault-break-in-animation')).toBe(true)
      expect(searchTemplates('laser').some((t) => t.id === 'vault-break-in-animation')).toBe(true)
    })

    it('has no per-item icon support (it is not a per-item list template)', () => {
      expect(TEMPLATE_ICON_SUPPORT['vault-break-in-animation']).toBe('none')
    })

    it('exposes eyebrow, title, and background as editable content slots', () => {
      expect(TEMPLATE_CONTENT_SLOTS['vault-break-in-animation']).toEqual(['eyebrow', 'title', 'background'])
    })
  })

  describe('Animated Break-In Vault Diagram', () => {
    it('is registered with a real component, name, description, and the Cybersecurity category', () => {
      const def = getTemplate('animated-break-in-vault-diagram')
      expect(def.name).toBe('Animated Break-In Vault Diagram')
      expect(typeof def.component).toBe('function')
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.category).toBe('cybersecurity')
    })

    it('defaults to full-frame so its foreground composition gets an independent, resizable content transform', () => {
      expect(getEffectivePresentationMode('animated-break-in-vault-diagram')).toBe('full-frame')
      expect(getSupportedPresentationModes('animated-break-in-vault-diagram')).toEqual(['full-frame', 'overlay'])
    })

    it('is recommended (without displacing existing strong defaults) for cybersecurity event, warning, sequence of steps, cause, and effect', () => {
      expect(TEMPLATE_RECOMMENDATIONS.cybersecurity_event).toContain('animated-break-in-vault-diagram')
      expect(TEMPLATE_RECOMMENDATIONS.warning).toContain('animated-break-in-vault-diagram')
      expect(TEMPLATE_RECOMMENDATIONS.sequence_of_steps).toContain('animated-break-in-vault-diagram')
      expect(TEMPLATE_RECOMMENDATIONS.cause).toContain('animated-break-in-vault-diagram') // closest match to "cause_and_effect"
      expect(TEMPLATE_RECOMMENDATIONS.effect).toContain('animated-break-in-vault-diagram')
      // The existing, already-strong defaults are untouched by adding this new recommendation.
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.cybersecurity_event).toBe('security-login-flow')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.warning).toBe('warning-alert')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.cause).toBe('cause-effect-flow')
    })

    it('is findable by search on its own id/name and reference tags', () => {
      expect(searchTemplates('Animated Break-In Vault Diagram').some((t) => t.id === 'animated-break-in-vault-diagram')).toBe(true)
      expect(searchTemplates('bank').some((t) => t.id === 'animated-break-in-vault-diagram')).toBe(true)
      expect(searchTemplates('hacker').some((t) => t.id === 'animated-break-in-vault-diagram')).toBe(true)
    })

    it('has no per-item icon support and exposes eyebrow/title/background as content slots', () => {
      expect(TEMPLATE_ICON_SUPPORT['animated-break-in-vault-diagram']).toBe('none')
      expect(TEMPLATE_CONTENT_SLOTS['animated-break-in-vault-diagram']).toEqual(['eyebrow', 'title', 'background'])
    })
  })

  describe('Data Center Cyber Intrusion', () => {
    it('is registered with a real component, name, description, and the Cybersecurity category', () => {
      const def = getTemplate('data-center-cyber-intrusion')
      expect(def.name).toBe('Data Center Cyber Intrusion')
      expect(typeof def.component).toBe('function')
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.category).toBe('cybersecurity')
    })

    it('defaults to full-frame so its foreground composition gets an independent, resizable content transform', () => {
      expect(getEffectivePresentationMode('data-center-cyber-intrusion')).toBe('full-frame')
      expect(getSupportedPresentationModes('data-center-cyber-intrusion')).toEqual(['full-frame', 'overlay'])
    })

    it('is recommended (without displacing existing strong defaults) for cybersecurity event, warning, and problem', () => {
      expect(TEMPLATE_RECOMMENDATIONS.cybersecurity_event).toContain('data-center-cyber-intrusion')
      expect(TEMPLATE_RECOMMENDATIONS.warning).toContain('data-center-cyber-intrusion')
      expect(TEMPLATE_RECOMMENDATIONS.problem).toContain('data-center-cyber-intrusion')
      // The existing, already-strong defaults are untouched by adding this new recommendation.
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.cybersecurity_event).toBe('security-login-flow')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.warning).toBe('warning-alert')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.problem).toBe('warning-alert')
    })

    it('is findable by search on its own id/name and reference tags', () => {
      expect(searchTemplates('Data Center Cyber Intrusion').some((t) => t.id === 'data-center-cyber-intrusion')).toBe(true)
      expect(searchTemplates('firewall').some((t) => t.id === 'data-center-cyber-intrusion')).toBe(true)
      expect(searchTemplates('packet').some((t) => t.id === 'data-center-cyber-intrusion')).toBe(true)
    })

    it('has no per-item icon support and exposes eyebrow/title/background as content slots', () => {
      expect(TEMPLATE_ICON_SUPPORT['data-center-cyber-intrusion']).toBe('none')
      expect(TEMPLATE_CONTENT_SLOTS['data-center-cyber-intrusion']).toEqual(['eyebrow', 'title', 'background'])
    })
  })

  describe('Hospital Emergency Response', () => {
    it('is registered with a real component, name, description, and the Diagrams category', () => {
      const def = getTemplate('hospital-emergency-response')
      expect(def.name).toBe('Hospital Emergency Response')
      expect(typeof def.component).toBe('function')
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.category).toBe('diagrams')
    })

    it('defaults to full-frame so its foreground composition gets an independent, resizable content transform', () => {
      expect(getEffectivePresentationMode('hospital-emergency-response')).toBe('full-frame')
      expect(getSupportedPresentationModes('hospital-emergency-response')).toEqual(['full-frame', 'overlay'])
    })

    it('is recommended (without displacing existing strong defaults) for sequence of steps and solution', () => {
      expect(TEMPLATE_RECOMMENDATIONS.sequence_of_steps).toContain('hospital-emergency-response')
      expect(TEMPLATE_RECOMMENDATIONS.solution).toContain('hospital-emergency-response')
      // The existing, already-strong defaults are untouched by adding this new recommendation.
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.sequence_of_steps).toBe('three-step-presenter-plan')
      expect(DEFAULT_TEMPLATE_FOR_PURPOSE.solution).toBe('cause-effect-flow')
    })

    it('is findable by search on its own id/name and reference tags', () => {
      expect(searchTemplates('Hospital Emergency Response').some((t) => t.id === 'hospital-emergency-response')).toBe(true)
      expect(searchTemplates('scanner').some((t) => t.id === 'hospital-emergency-response')).toBe(true)
      expect(searchTemplates('patient').some((t) => t.id === 'hospital-emergency-response')).toBe(true)
    })

    it('has no per-item icon support and exposes eyebrow/title/background as content slots', () => {
      expect(TEMPLATE_ICON_SUPPORT['hospital-emergency-response']).toBe('none')
      expect(TEMPLATE_CONTENT_SLOTS['hospital-emergency-response']).toEqual(['eyebrow', 'title', 'background'])
    })
  })
})
