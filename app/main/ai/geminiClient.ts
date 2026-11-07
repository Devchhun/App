import { GoogleGenAI, type GenerateContentParameters, type ThinkingLevel } from '@google/genai'
import { fallbackModels, isBusyModelError, isDailyQuotaError, isRetiredModelError, isThinkingConfigError, quotaRetryMs, suggestedModel, thinkingLevelFor, THINKING_LEVEL_HEADROOM, usesThinkingLevel } from '@shared/geminiModels'
import { geminiKeyPool, isPerMinuteQuotaError, isRefusedKeyError, minuteLimitCoolDownMs, REFUSED_COOL_DOWN_MS } from '@shared/geminiKeyPool'

/** Models a key cannot use for now, and until when ("key|model"): retired for
 * that key (for good), or out of its daily quota (the free tier gives each
 * model its own small count a day). Later calls pass over them instead of
 * failing on them again. */
const unusable = new Map<string, number>()
/** Models overloaded a moment ago. That is Google's load, not the key's:
 * another key would only be told the same. */
const overloaded = new Map<string, number>()
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

/** The SDK's own calls for one key, from before createGemini changes them. */
interface KeyClient {
  ai: GoogleGenAI
  generate: GoogleGenAI['models']['generateContent']
  upload: GoogleGenAI['files']['upload']
  get: GoogleGenAI['files']['get']
  remove: GoogleGenAI['files']['delete']
}

const openClient = (ai: GoogleGenAI): KeyClient => ({
  ai,
  generate: ai.models.generateContent,
  upload: ai.files?.upload?.bind(ai.files),
  get: ai.files?.get?.bind(ai.files),
  remove: ai.files?.delete?.bind(ai.files)
})

type UploadParams = Parameters<GoogleGenAI['files']['upload']>[0]

/** A file exists only for the key that uploaded it: the same file on another
 * key is another upload. Each copy, by key, so it is read with the right key
 * and uploaded again when that key runs out. */
interface UploadedFile {
  source: UploadParams
  copies: Map<string, { name: string; uri: string }>
}
const filesByUri = new Map<string, UploadedFile>()
const filesByName = new Map<string, UploadedFile>()
/** How long a new copy may take to get ready on the next key. */
const COPY_READY_TIMEOUT_MS = 10 * 60 * 1000

/** `value` with every fileUri in it replaced; everything else is the same object. */
function mapFileUris<T>(value: T, change: (uri: string) => string): T {
  if (Array.isArray(value)) return value.map((item) => mapFileUris(item, change)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, name === 'fileUri' && typeof item === 'string' ? change(item) : mapFileUris(item, change)])
  ) as T
}

function fileUrisIn(contents: unknown): string[] {
  const found: string[] = []
  mapFileUris(contents, (uri) => {
    found.push(uri)
    return uri
  })
  return found
}

const keyTail = (key: string): string => `…${key.slice(-4)}`

/** A Gemini client that copes with a model or a key that cannot answer. Every
 * desktop Gemini service creates its client here, so none of them breaks for
 * a new or a free key.
 *
 * Models: the best one the key can use answers each call -- the one asked
 * for, else the newest of its kind (shared/geminiModels.ts). One that is
 * retired for this key ("no longer available to new users"), out of its daily
 * free quota or overloaded is passed over and remembered. Thinking settings a
 * newer model does not take are translated for it.
 *
 * Keys: with several keys saved (shared/geminiKeyPool.ts), one that has no
 * model left today, hits its per-minute limit or is refused by Google hands
 * the call to the next key. Uploaded files go along: they are uploaded again
 * for the next key, because a file can only be read by the key that uploaded
 * it. */
export function createGemini(apiKey: string): GoogleGenAI {
  const ai = new GoogleGenAI({ apiKey })
  const clients = new Map<string, KeyClient>([[apiKey, openClient(ai)]])
  const clientFor = (key: string): KeyClient => {
    let client = clients.get(key)
    if (!client) {
      client = openClient(new GoogleGenAI({ apiKey: key }))
      clients.set(key, client)
    }
    return client
  }
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  /** One model, asked once more without thinking settings if it refuses them. */
  const ask = async (key: string, params: GenerateContentParameters, model: string): ReturnType<KeyClient['generate']> => {
    const { generate } = clientFor(key)
    const shaped = forModel(params, model)
    try {
      return await generate(shaped)
    } catch (error) {
      if (!shaped.config?.thinkingConfig || !isThinkingConfigError(message(error))) throw error
      return generate(withoutThinking(shaped))
    }
  }
  const usable = (key: string, model: string): boolean => (unusable.get(`${key}|${model}`) ?? 0) <= Date.now() && (overloaded.get(model) ?? 0) <= Date.now()
  /** Whether another model should be asked instead (and why this one is out). */
  const passOver = (error: unknown, key: string, model: string): boolean => {
    const text = message(error)
    if (isRetiredModelError(text)) unusable.set(`${key}|${model}`, Number.POSITIVE_INFINITY)
    else if (isDailyQuotaError(text)) unusable.set(`${key}|${model}`, Date.now() + (quotaRetryMs(text) ?? 60 * 60 * 1000))
    else if (isBusyModelError(text)) overloaded.set(model, Date.now() + BUSY_COOL_DOWN_MS)
    else return false
    return true
  }
  /** Which failure to report when nothing answered: the one most worth waiting for. */
  const weight = (error: unknown): number => {
    const text = message(error)
    return isBusyModelError(text) ? 3 : isPerMinuteQuotaError(text) ? 2 : isDailyQuotaError(text) ? 1 : 0
  }

  ai.models.generateContent = async (params) => {
    const requested = params.model
    let last: unknown = null
    const remember = (error: unknown): void => {
      if (!last || weight(error) >= weight(last)) last = error
    }
    let answeredBy = requested

    /** This key's best answer; null when it has no model left for now. */
    const askKey = async (key: string, shaped: GenerateContentParameters): Promise<Awaited<ReturnType<KeyClient['generate']>> | null> => {
      let suggestion: string | null = null
      const tryModel = async (model: string): Promise<Awaited<ReturnType<KeyClient['generate']>> | null> => {
        try {
          const response = await ask(key, shaped, model)
          answeredBy = model
          if (model !== requested && lastStandIn.get(requested) !== model) {
            console.warn(`[gemini] ${requested} cannot answer for this key now; using ${model}.`)
            lastStandIn.set(requested, model)
          }
          return response
        } catch (error) {
          if (!passOver(error, key, model)) throw error
          suggestion ??= suggestedModel(message(error))
          remember(error)
          return null
        }
      }
      if (usable(key, requested)) {
        const response = await tryModel(requested)
        if (response) return response
      }
      const others = fallbackModels(requested, await availableModels(clientFor(key).ai, key).catch(() => []), suggestion)
        .filter((name) => name !== requested && usable(key, name))
        .slice(0, MAX_MODELS_PER_CALL)
      for (const model of others) {
        const response = await tryModel(model)
        if (response) return response
      }
      return null
    }

    /** The call with its uploaded files as `key` can read them, uploading
     * them for that key if needed; null when that cannot be done. */
    const withFilesFor = async (key: string, uris: string[]): Promise<GenerateContentParameters | null> => {
      const moved = new Map<string, string>()
      try {
        for (const uri of uris) {
          const file = filesByUri.get(uri)
          if (!file) return null
          let copy = file.copies.get(key)
          if (!copy) {
            const uploaded = await clientFor(key).upload(file.source)
            if (!uploaded.name || !uploaded.uri) return null
            await waitUntilReady(clientFor(key), uploaded.name, params.config?.abortSignal)
            copy = { name: uploaded.name, uri: uploaded.uri }
            file.copies.set(key, copy)
            filesByUri.set(copy.uri, file)
          }
          moved.set(uri, copy.uri)
        }
      } catch (error) {
        if (params.config?.abortSignal?.aborted) throw error
        console.warn(`[gemini] could not upload the file again for key ${keyTail(key)}: ${message(error)}`)
        return null
      }
      return { ...params, contents: mapFileUris(params.contents, (uri) => moved.get(uri) ?? uri) }
    }

    const uris = fileUrisIn(params.contents)
    const known = uris.filter((uri) => filesByUri.has(uri))
    // A file from elsewhere can only be read by the key asked.
    const fileKey = known.length > 0 ? [...(filesByUri.get(known[0])?.copies.keys() ?? [])].find((key) => filesByUri.get(known[0])?.copies.get(key)?.uri === known[0]) : undefined
    const order = uris.length > known.length ? [apiKey] : [...new Set([...(fileKey ? [fileKey] : []), ...geminiKeyPool.order(apiKey)])]

    for (let i = 0; i < order.length; i++) {
      const key = order[i]
      const shaped = known.length > 0 ? await withFilesFor(key, known) : params
      if (!shaped) continue
      try {
        const response = await askKey(key, shaped)
        if (response) {
          if (key !== geminiKeyPool.best(apiKey)) console.warn(`[gemini] moved to key ${keyTail(key)}.`)
          geminiKeyPool.noteAnswer(key, answeredBy)
          return response
        }
        // No model left: out until the first of them is back (only busy: it passes).
        const times = [...unusable.entries()].filter(([name]) => name.startsWith(`${key}|`)).map(([, until]) => until).filter((until) => until > Date.now())
        if (times.length > 0) geminiKeyPool.markOut(key, Math.min(Math.min(...times) - Date.now(), 24 * 60 * 60 * 1000))
      } catch (error) {
        const text = message(error)
        if (isRefusedKeyError(text)) {
          geminiKeyPool.markOut(key, REFUSED_COOL_DOWN_MS, 'refused')
          console.warn(`[gemini] Google refused key ${keyTail(key)}; trying the next one.`)
        } else if (isPerMinuteQuotaError(text)) {
          geminiKeyPool.markOut(key, minuteLimitCoolDownMs(text), 'minute')
        } else {
          throw error
        }
        remember(error)
      }
    }
    if (last) throw last
    throw new Error("Gemini's free daily limit is used up on every key and every model (the free tier allows about 20 requests a day for each model). Add a key, use one with billing turned on, or try again later. [429 RESOURCE_EXHAUSTED per day]")
  }

  if (ai.files) {
    const base = clientFor(apiKey)
    ai.files.upload = async (params) => {
      let last: unknown = null
      for (const key of geminiKeyPool.order(apiKey)) {
        try {
          const uploaded = await clientFor(key).upload(params)
          if (uploaded.name && uploaded.uri) {
            const file: UploadedFile = { source: params, copies: new Map([[key, { name: uploaded.name, uri: uploaded.uri }]]) }
            filesByUri.set(uploaded.uri, file)
            filesByName.set(uploaded.name, file)
          }
          return uploaded
        } catch (error) {
          if (!isRefusedKeyError(message(error))) throw error
          geminiKeyPool.markOut(key, REFUSED_COOL_DOWN_MS, 'refused')
          last = error
        }
      }
      throw last
    }
    ai.files.get = async (params) => {
      const file = filesByName.get(params.name)
      const owner = file && [...file.copies.entries()].find(([, copy]) => copy.name === params.name)?.[0]
      return (owner ? clientFor(owner) : base).get(params)
    }
    ai.files.delete = async (params) => {
      const file = filesByName.get(params.name)
      if (!file) return base.remove(params)
      filesByName.delete(params.name)
      const copies = [...file.copies.entries()]
      for (const [, copy] of copies) filesByUri.delete(copy.uri)
      const results = await Promise.allSettled(copies.map(([key, copy]) => clientFor(key).remove({ ...params, name: copy.name })))
      const first = results[0]
      if (first.status === 'rejected') throw first.reason
      return first.value
    }
  }
  return ai
}

/** A new copy of a file, ready to be read. */
async function waitUntilReady(client: KeyClient, name: string, signal?: AbortSignal): Promise<void> {
  const giveUp = Date.now() + COPY_READY_TIMEOUT_MS
  for (;;) {
    if (signal?.aborted) throw new Error('Canceled')
    const file = await client.get({ name })
    if (file.state === undefined || String(file.state) === 'ACTIVE') return
    if (String(file.state) !== 'PROCESSING') throw new Error(file.error?.message ?? 'Gemini could not process the file.')
    if (Date.now() > giveUp) throw new Error('Gemini took too long to process the file.')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
