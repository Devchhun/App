/** Several Gemini keys used as one: when a key runs out of quota or Google
 * refuses it, the work moves to the next key by itself. Shared by the desktop
 * (app/main/ai/geminiClient.ts) and the phone (mobile/src/ai/gemini.ts); each
 * app has one pool, filled from where it keeps its keys. */

import { isDailyQuotaError, quotaRetryMs } from './geminiModels'

/** A key Google refused is asked again after this long (billing may be added). */
export const REFUSED_COOL_DOWN_MS = 60 * 60 * 1000
/** When Google gives no wait for a per-minute limit. */
const MINUTE_LIMIT_COOL_DOWN_MS = 60 * 1000

/** The keys in pasted text, in order and without repeats: one per line, or
 * separated by spaces or commas. Anything else in the text, such as the email
 * written next to a key, is left out. */
export function parseGeminiKeys(text: string): string[] {
  const tokens = text.split(/[\s,;]+/).filter((token) => token.length >= 10 && /^[\w.-]+$/.test(token))
  return [...new Set(tokens)]
}

/** `added` first, so a new key is tried before an older one that may be why
 * it was added; keys already kept stay as they are. */
export function mergeGeminiKeys(added: string[], kept: string[]): string[] {
  return [...new Set([...added, ...kept])]
}

/** Enough to recognise a key by, never the whole key. */
export function maskGeminiKey(key: string): string {
  return key ? `${key.slice(0, 4)}…${key.slice(-4)}` : ''
}

/** Google says no to the key itself: wrong, expired, no free tier for its
 * project, suspended, out of prepaid credits. Another key can still answer.
 * Being refused one uploaded file says nothing about the key. */
export function isRefusedKeyError(text: string): boolean {
  if (/\bfiles?\b/i.test(text)) return false
  return /API_KEY_INVALID|API key (?:not valid|expired)|free tier is not available|PERMISSION_DENIED|UNAUTHENTICATED|CONSUMER_SUSPENDED|has been suspended|prepayment credits|credits are depleted/i.test(text)
}

/** A limit that passes within minutes. The limit belongs to the key's project,
 * so another key can answer now instead of waiting. */
export function isPerMinuteQuotaError(text: string): boolean {
  return /RESOURCE_EXHAUSTED|\b429\b/i.test(text) && !isDailyQuotaError(text)
}

/** How long a key stays out after a per-minute limit. */
export function minuteLimitCoolDownMs(text: string): number {
  return quotaRetryMs(text) ?? MINUTE_LIMIT_COOL_DOWN_MS
}

/** A key as the Router screen shows it. active: the one in use or next up.
 * minute / quota / refused: out for that reason, until `backAt`. */
export type GeminiKeyState = 'active' | 'ready' | 'minute' | 'quota' | 'refused'
export type GeminiOutReason = 'minute' | 'quota' | 'refused'

export interface GeminiKeySnapshot {
  /** Never the whole key. */
  mask: string
  state: GeminiKeyState
  backAt: number | null
  answered: number
  failed: number
  /** The model that last answered with this key. */
  model: string | null
  lastAnsweredAt: number | null
}

export interface GeminiRouterEvent {
  id: number
  at: number
  kind: 'answer' | 'move' | GeminiOutReason | 'test'
  mask: string
  text: string
}

/** What the Router screen draws. Holds no key, so it can cross to a window. */
export interface GeminiRouterSnapshot {
  keys: GeminiKeySnapshot[]
  /** Newest first. */
  events: GeminiRouterEvent[]
  answered: number
  moves: number
  failures: number
  /** When these counts began: they are kept for this run of the app. */
  since: number
}

const MAX_EVENTS = 60

const OUT_TEXT: Record<GeminiOutReason, string> = {
  minute: 'Per-minute limit reached',
  quota: 'Out of quota for now',
  refused: 'Refused by Google'
}

/** Which key to use now. It stays on one key while that key answers, and
 * only moves when a key is out. */
export class GeminiKeyPool {
  private keys: string[] = []
  private current: string | null = null
  private lastUsed: string | null = null
  private readonly outUntil = new Map<string, number>()
  private readonly outReason = new Map<string, GeminiOutReason>()
  private readonly stats = new Map<string, { answered: number; failed: number; model: string | null; lastAnsweredAt: number | null }>()
  private events: GeminiRouterEvent[] = []
  private nextEvent = 1
  private moves = 0
  private readonly since: number

  constructor(private readonly now: () => number = () => Date.now()) {
    this.since = now()
  }

  get size(): number {
    return this.keys.length
  }

  /** The keys changed. What is known about the ones that remain is kept. */
  setKeys(keys: string[]): void {
    this.keys = [...new Set(keys)]
    if (this.current && !this.keys.includes(this.current)) this.current = null
    for (const key of [...this.outUntil.keys()]) {
      if (!this.keys.includes(key)) {
        this.outUntil.delete(key)
        this.outReason.delete(key)
      }
    }
  }

  /** Keys to try, best first: the one in use, then the next ones in turn.
   * With every key out, all of them by which is back soonest, so a call
   * always reaches Google and gets a real answer. `asked` is a key a caller
   * already holds, used even if the pool does not know it. */
  order(asked?: string): string[] {
    const all = asked && !this.keys.includes(asked) ? [asked, ...this.keys] : this.keys
    const isOut = (key: string): boolean => (this.outUntil.get(key) ?? 0) > this.now()
    const ready = all.filter((key) => !isOut(key))
    if (ready.length === 0) return [...all].sort((a, b) => (this.outUntil.get(a) ?? 0) - (this.outUntil.get(b) ?? 0))
    const first = this.current ?? asked
    const at = first ? ready.indexOf(first) : -1
    return at > 0 ? [...ready.slice(at), ...ready.slice(0, at)] : ready
  }

  /** The key to start a new piece of work with. */
  best(asked?: string): string | null {
    return this.order(asked)[0] ?? null
  }

  markWorking(key: string): void {
    if (this.lastUsed && this.lastUsed !== key) {
      this.moves++
      this.addEvent('move', key, `Took over from ${maskGeminiKey(this.lastUsed)}`)
    }
    this.lastUsed = key
    this.current = key
    this.outUntil.delete(key)
    this.outReason.delete(key)
  }

  /** `key` answered a request. */
  noteAnswer(key: string, model: string): void {
    this.markWorking(key)
    const stat = this.statOf(key)
    stat.answered++
    stat.model = model
    stat.lastAnsweredAt = this.now()
    this.addEvent('answer', key, `Answered · ${model}`)
  }

  markOut(key: string, forMs: number, reason: GeminiOutReason = 'quota'): void {
    // Told again while already out for this reason: one line in the log is enough.
    if (this.backAt(key) === null || this.outReason.get(key) !== reason) {
      this.statOf(key).failed++
      this.addEvent(reason, key, OUT_TEXT[reason])
    }
    this.outUntil.set(key, this.now() + forMs)
    this.outReason.set(key, reason)
    if (this.current === key) this.current = null
  }

  /** The result of asking a key directly (probeGeminiKeys). */
  noteTest(key: string, passed: boolean, text: string): void {
    if (passed) {
      this.outUntil.delete(key)
      this.outReason.delete(key)
    }
    this.addEvent('test', key, text)
  }

  /** Every key, without regard to which are out. */
  all(): string[] {
    return [...this.keys]
  }

  snapshot(): GeminiRouterSnapshot {
    const next = this.best()
    const keys = this.keys.map((key): GeminiKeySnapshot => {
      const backAt = this.backAt(key)
      const stat = this.statOf(key)
      return {
        mask: maskGeminiKey(key),
        state: backAt !== null ? (this.outReason.get(key) ?? 'quota') : key === next ? 'active' : 'ready',
        backAt,
        answered: stat.answered,
        failed: stat.failed,
        model: stat.model,
        lastAnsweredAt: stat.lastAnsweredAt
      }
    })
    return {
      keys,
      events: [...this.events],
      answered: keys.reduce((sum, key) => sum + key.answered, 0),
      moves: this.moves,
      failures: keys.reduce((sum, key) => sum + key.failed, 0),
      since: this.since
    }
  }

  private statOf(key: string): { answered: number; failed: number; model: string | null; lastAnsweredAt: number | null } {
    let stat = this.stats.get(key)
    if (!stat) {
      stat = { answered: 0, failed: 0, model: null, lastAnsweredAt: null }
      this.stats.set(key, stat)
    }
    return stat
  }

  private addEvent(kind: GeminiRouterEvent['kind'], key: string, text: string): void {
    this.events = [{ id: this.nextEvent++, at: this.now(), kind, mask: maskGeminiKey(key), text }, ...this.events].slice(0, MAX_EVENTS)
  }

  /** When a key that is out comes back; null when it is not out. */
  backAt(key: string): number | null {
    const until = this.outUntil.get(key) ?? 0
    return until > this.now() ? until : null
  }
}

/** This app's keys. */
export const geminiKeyPool = new GeminiKeyPool()

/** The model a test asks. A key that cannot use it (404) has still been let in. */
const TEST_MODEL = 'gemini-2.5-flash'

/** Asks every key for one word, because only generating shows what listing
 * models hides (a project with no free tier). A key that can still use the
 * test model spends one request of its daily count. */
export async function probeGeminiKeys(pool: GeminiKeyPool, base: string, doFetch: typeof fetch = fetch): Promise<void> {
  await Promise.all(
    pool.all().map(async (key) => {
      let status = 0
      let body = ''
      try {
        const limit = new AbortController()
        const timer = setTimeout(() => limit.abort(), 20_000)
        try {
          const res = await doFetch(`${base}/v1beta/models/${TEST_MODEL}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 1 } }),
            signal: limit.signal
          })
          status = res.status
          body = await res.text()
        } finally {
          clearTimeout(timer)
        }
      } catch {
        pool.noteTest(key, false, 'Test: no answer. Check the internet')
        return
      }
      if (status === 200 || status === 404) pool.noteTest(key, true, 'Test passed')
      else if (isRefusedKeyError(body) || status === 401 || status === 403) pool.markOut(key, REFUSED_COOL_DOWN_MS, 'refused')
      else if (status === 429 && isDailyQuotaError(body)) pool.noteTest(key, true, `Test passed · ${TEST_MODEL} is out for today, other models remain`)
      else if (status === 429) pool.markOut(key, minuteLimitCoolDownMs(body), 'minute')
      else pool.noteTest(key, false, `Test: Google answered ${status}`)
    })
  )
}
