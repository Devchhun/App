import { GoogleGenAI, type GenerateContentParameters, type ThinkingLevel } from '@google/genai'
import { fallbackModels, isBusyModelError, isDailyQuotaError, isRetiredModelError, isThinkingConfigError, quotaRetryMs, suggestedModel, thinkingLevelFor, THINKING_LEVEL_HEADROOM, usesThinkingLevel } from '@shared/geminiModels'

/** Models that cannot answer for now, and until when: retired (for good),
 * out of this key's daily quota (the free tier gives each model its own
 * small count a day), or overloaded a moment ago. Later calls pass over
 * them instead of failing on them again. */
const unusable = new Map<string, number>()
/** The stand-in last reported for a model (one log line per change). */
const lastStandIn = new Map<string, string>()
/** The models each key can use, asked once per key. */
const modelLists = new Map<string, Promise<string[]>>()
/** Models tried for one call before giving up. */
const MAX_MODELS_PER_CALL = 6
/** An overloaded model is left alone this long. */
const BUSY_COOL_DOWN_MS = 15_000

async function availableModels(ai: GoogleGenAI, apiKey: string): Promise<string[]> {
  let job = modelLists.get(apiKey)
  if (!job) {
    job = (async () => {
      const names: string[] = []
      const pager = await ai.models.list({ config: { pageSize: 200 } })
      for await (const model of pager) {
        if (model.name && (!model.supportedActions || model.supportedActions.includes('generateContent'))) names.push(model.name)
      }
      return names
    })()
    job.catch(() => modelLists.delete(apiKey))
    modelLists.set(apiKey, job)
  }
  return job
}

// The SDK's ThinkingLevel values, as text: the enum itself is not there
// when a test stands in for the SDK.
const LEVELS = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } as Record<'low' | 'medium' | 'high', ThinkingLevel>

/** The call as `model` takes it. The services write their thinking for the
 * 2.5 models (a token budget, 0 = off); a Gemini 3 stand-in sets it by
 * level and cannot switch it off, so the budget becomes the nearest level
 * -- and an answer whose thinking was off gets room for the thinking that
 * now counts against its limit. */
function forModel(params: GenerateContentParameters, model: string): GenerateContentParameters {
  const thinking = params.config?.thinkingConfig
  const budget = thinking?.thinkingBudget
  if (!usesThinkingLevel(model) || !thinking || thinking.thinkingLevel !== undefined || typeof budget !== 'number') return { ...params, model }
  const { thinkingBudget: _budget, ...rest } = thinking
  void _budget
  const max = params.config?.maxOutputTokens
  return {
    ...params,
    model,
    config: {
      ...params.config,
      // A dynamic budget (-1) is the model's own default.
      thinkingConfig: budget < 0 ? rest : { ...rest, thinkingLevel: LEVELS[thinkingLevelFor(budget)] },
      ...(budget === 0 && typeof max === 'number' ? { maxOutputTokens: max + THINKING_LEVEL_HEADROOM } : {})
    }
  }
}

/** The same call with no thinking settings at all (the model's defaults). */
function withoutThinking(params: GenerateContentParameters): GenerateContentParameters {
  if (!params.config?.thinkingConfig) return params
  const { thinkingConfig: _thinking, ...config } = params.config
  void _thinking
  return { ...params, config }
}

/** A Gemini client that copes with a model that cannot answer: retired
 * for this key ("no longer available to new users"), out of its daily free
 * quota, or overloaded. The best model the key can use answers each call
 * -- the one asked for, else the newest of its kind
 * (shared/geminiModels.ts) -- and one that cannot is passed over and
 * remembered. Thinking settings a newer model does not take are
 * translated for it. Every desktop Gemini service creates its client
 * here, so none of them breaks for a new or a free key. */
export function createGemini(apiKey: string): GoogleGenAI {
  const ai = new GoogleGenAI({ apiKey })
  const original = ai.models.generateContent
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  /** One model, asked once more without thinking settings if it refuses them. */
  const ask = async (params: GenerateContentParameters, model: string): ReturnType<typeof original> => {
    const shaped = forModel(params, model)
    try {
      return await original(shaped)
    } catch (error) {
      if (!shaped.config?.thinkingConfig || !isThinkingConfigError(message(error))) throw error
      return original(withoutThinking(shaped))
    }
  }
  const usable = (model: string): boolean => (unusable.get(model) ?? 0) <= Date.now()
  /** Whether another model should be asked instead (and why this one is out). */
  const passOver = (error: unknown, model: string): boolean => {
    const text = message(error)
    if (isRetiredModelError(text)) unusable.set(model, Number.POSITIVE_INFINITY)
    else if (isDailyQuotaError(text)) unusable.set(model, Date.now() + (quotaRetryMs(text) ?? 60 * 60 * 1000))
    else if (isBusyModelError(text)) unusable.set(model, Date.now() + BUSY_COOL_DOWN_MS)
    else return false
    return true
  }
  ai.models.generateContent = async (params) => {
    const requested = params.model
    let last: unknown = null
    let suggestion: string | null = null
    const tryModel = async (model: string): Promise<Awaited<ReturnType<typeof original>> | null> => {
      try {
        const response = await ask(params, model)
        if (model !== requested && lastStandIn.get(requested) !== model) {
          console.warn(`[gemini] ${requested} cannot answer for this key now; using ${model}.`)
          lastStandIn.set(requested, model)
        }
        return response
      } catch (error) {
        if (!passOver(error, model)) throw error
        suggestion ??= suggestedModel(message(error))
        // Reported when nothing answers: "busy" (it passes) before a daily limit.
        if (!last || isBusyModelError(message(error)) || !isBusyModelError(message(last))) last = error
        return null
      }
    }
    if (usable(requested)) {
      const response = await tryModel(requested)
      if (response) return response
    }
    const others = fallbackModels(requested, await availableModels(ai, apiKey).catch(() => []), suggestion)
      .filter((name) => name !== requested && usable(name))
      .slice(0, MAX_MODELS_PER_CALL)
    for (const model of others) {
      const response = await tryModel(model)
      if (response) return response
    }
    if (last) throw last
    throw new Error("Gemini's free daily limit is used up on every model this key can use (the free tier allows about 20 requests a day for each model). Use a key with billing turned on, or try again later. [429 RESOURCE_EXHAUSTED per day]")
  }
  return ai
}
