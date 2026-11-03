import { describe, expect, it } from 'vitest'
import { fallbackModels, isBusyModelError, isDailyQuotaError, isRetiredModelError, isThinkingConfigError, modelVersion, pickReplacement, quotaRetryMs, replacementCandidates, suggestedModel, thinkingLevelFor, usesThinkingLevel } from './geminiModels'

const MESSAGE =
  'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.'

describe('retired Gemini models', () => {
  it('recognises the retirement message and its suggestion', () => {
    expect(isRetiredModelError(MESSAGE)).toBe(true)
    expect(suggestedModel(MESSAGE)).toBe('gemini-3.8-flash')
    expect(isRetiredModelError('API key not valid. Please pass a valid API key.')).toBe(false)
    expect(isRetiredModelError('Resource has been exhausted (e.g. check quota).')).toBe(false)
  })

  it("takes Google's suggestion when the key can use it", () => {
    expect(pickReplacement('gemini-2.5-flash', ['models/gemini-3.8-flash', 'models/gemini-3.9-flash-preview'], 'gemini-3.8-flash')).toBe('gemini-3.8-flash')
  })

  it('otherwise the newest stable model of the same family', () => {
    const available = ['models/gemini-3.1-pro-preview', 'models/gemini-3.8-flash', 'models/gemini-3.5-flash', 'models/gemini-3.9-flash-preview-05-2026', 'models/gemini-3.8-flash-lite', 'models/gemini-3.8-flash-image', 'models/text-embedding-004']
    expect(pickReplacement('gemini-2.5-flash', available)).toBe('gemini-3.8-flash')
    expect(pickReplacement('gemini-2.5-pro', available)).toBe('gemini-3.1-pro-preview')
  })

  it('a preview when there is no stable one; null when nothing fits', () => {
    expect(pickReplacement('gemini-2.5-flash', ['gemini-3.9-flash-preview'])).toBe('gemini-3.9-flash-preview')
    expect(pickReplacement('gemini-2.5-flash', ['gemini-3.8-flash-lite', 'gemini-3.1-pro'])).toBeNull()
  })

  it('lists the stand-ins to try in order: suggestion, current stable, current preview, older last', () => {
    const available = ['models/gemini-2.0-flash', 'models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'models/gemini-3-flash-preview', 'models/gemini-3.5-flash', 'models/gemini-2.5-flash-lite']
    expect(replacementCandidates('gemini-2.5-flash', available)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.0-flash'])
    expect(replacementCandidates('gemini-2.5-flash', available, 'gemini-3.5-flash')[0]).toBe('gemini-3.5-flash')
  })

  it('an older model is never chosen before a newer preview (it is usually retired too)', () => {
    expect(pickReplacement('gemini-2.5-flash', ['gemini-2.0-flash', 'gemini-3-flash-preview'])).toBe('gemini-3-flash-preview')
  })

  it("tries Google's suggestion last when the key's list does not have it", () => {
    expect(replacementCandidates('gemini-2.5-flash', ['gemini-3.5-flash'], 'gemini-3.8-flash')).toEqual(['gemini-3.5-flash', 'gemini-3.8-flash'])
    expect(replacementCandidates('gemini-2.5-flash', [], 'gemini-3.8-flash')).toEqual(['gemini-3.8-flash'])
  })
})

describe('thinking settings across model generations', () => {
  it('Gemini 3 thinks by level, 2.5 by budget', () => {
    expect(modelVersion('models/gemini-3.8-flash')).toBe(3.8)
    expect(usesThinkingLevel('gemini-3.8-flash')).toBe(true)
    expect(usesThinkingLevel('gemini-3-flash-preview')).toBe(true)
    expect(usesThinkingLevel('gemini-2.5-flash')).toBe(false)
    expect(usesThinkingLevel('gemini-flash-latest')).toBe(false)
  })

  it('turns a budget into the nearest level (off becomes low: it cannot be off)', () => {
    expect(thinkingLevelFor(0)).toBe('low')
    expect(thinkingLevelFor(1024)).toBe('low')
    expect(thinkingLevelFor(4096)).toBe('medium')
    expect(thinkingLevelFor(8192)).toBe('high')
  })

  it('recognises a refusal of the thinking settings', () => {
    expect(isThinkingConfigError('Budget 0 is invalid. This model only works in thinking mode.')).toBe(true)
    expect(isThinkingConfigError('Unable to submit request because thinking_budget is not supported for this model.')).toBe(true)
    expect(isThinkingConfigError('Invalid value at generation_config.thinking_config.thinking_level')).toBe(true)
    expect(isThinkingConfigError('API key not valid.')).toBe(false)
  })
})

// Google's own answers to a free key, 2026-10-06.
const DAILY =
  'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash. Please retry in 9h33m32.384261383s. "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier" RESOURCE_EXHAUSTED'
const PER_MINUTE = 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 5. Please retry in 34.5s. RESOURCE_EXHAUSTED'
const BUSY = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'

describe('a model that cannot answer right now', () => {
  it('tells a used-up day from a busy minute', () => {
    expect(isDailyQuotaError(DAILY)).toBe(true)
    expect(quotaRetryMs(DAILY)).toBe(Math.ceil((9 * 3600 + 33 * 60 + 32.384261383) * 1000))
    expect(isDailyQuotaError(PER_MINUTE)).toBe(false)
    expect(quotaRetryMs(PER_MINUTE)).toBe(34500)
    expect(isDailyQuotaError(BUSY)).toBe(false)
  })

  it('recognises an overloaded model', () => {
    expect(isBusyModelError(BUSY)).toBe(true)
    expect(isBusyModelError(DAILY)).toBe(false)
  })

  it('takes a bare "invalid argument" as a refusal of the thinking settings', () => {
    expect(isThinkingConfigError('Request contains an invalid argument.')).toBe(true)
  })

  it('never falls back to a Lite model (its Khmer is not usable)', () => {
    const available = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest']
    expect(fallbackModels('gemini-2.5-flash', available)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash'])
  })
})
