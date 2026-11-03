/** Google retires Gemini model versions: a key then gets 404 "This model
 * models/gemini-2.5-flash is no longer available to new users. Please
 * update your code to use models/gemini-3.8-flash ...". Rather than ship a
 * new build each time, the apps ask Google which models the key can use and
 * move to the newest of the same kind -- a Flash for a Flash, a Pro for a
 * Pro. Shared by the desktop (app/main/ai/geminiClient.ts) and the phone
 * (mobile/src/ai/gemini.ts). */

/** A 404 / "not found" / "no longer available" about the model itself. */
export function isRetiredModelError(text: string): boolean {
  return /no longer available|is not found|not found for api version|is not supported for generatecontent|was retired|deprecated/i.test(text) && /models?\//i.test(text)
}

/** The model Google names in its message ("...to use models/gemini-3.8-flash"). */
export function suggestedModel(text: string): string | null {
  const m = /\buse\s+(?:the\s+)?models\/([a-z0-9.\-]+)/i.exec(text)
  return m ? m[1].replace(/[.\-]+$/, '') : null
}

const NAME = /^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-(.+))?$/
/** Variants that are not a general text/vision model. */
const SPECIAL = /lite|image|tts|audio|live|embedding|thinking|robotics|computer|search|native/i

function familyOf(model: string): 'flash' | 'pro' {
  return /-pro\b|-pro-/.test(model) ? 'pro' : 'flash'
}

/** "gemini-3.8-flash" -> 3.8; NaN for a name without a version. */
export function modelVersion(model: string): number {
  const m = NAME.exec(model.replace(/^models\//, ''))
  return m ? Number(m[1]) : Number.NaN
}

/** The stand-ins for `preferred` among `available` (names with or without
 * "models/"), best first: the same family; Google's own `suggestion` when
 * the key can use it; then models at least as new as `preferred` before
 * older ones (an older one is usually retired too), a stable release
 * before a preview, the newest version first. A call that is refused for
 * one moves on to the next. */
export function replacementCandidates(preferred: string, available: string[], suggestion?: string | null): string[] {
  const names = [...new Set(available.map((n) => n.replace(/^models\//, '')))]
  const family = familyOf(preferred)
  const floor = modelVersion(preferred)
  const ranked = names
    .map((name) => {
      const m = NAME.exec(name)
      if (!m || m[2] !== family || name === preferred) return null
      const suffix = m[3] ?? ''
      if (SPECIAL.test(suffix)) return null
      // Plain ("gemini-3.8-flash") or a preview/latest tag; dated experiments last.
      const stability = suffix === '' || suffix === 'latest' ? 2 : /preview/.test(suffix) ? 1 : 0
      const version = Number(m[1])
      return { name, version, stability, current: Number.isNaN(floor) || version >= floor ? 1 : 0 }
    })
    .filter((x): x is { name: string; version: number; stability: number; current: number } => !!x)
    .sort((a, b) => b.current - a.current || b.stability - a.stability || b.version - a.version)
    .map((x) => x.name)
  const fits = !!suggestion && familyOf(suggestion) === family && suggestion !== preferred
  const out = fits && names.includes(suggestion!) ? [suggestion!, ...ranked.filter((n) => n !== suggestion)] : ranked
  // Named by Google but not in the key's list: still worth one try, last.
  return fits && !out.includes(suggestion!) ? [...out, suggestion!] : out
}

/** The best stand-in (see replacementCandidates); null when nothing fits. */
export function pickReplacement(preferred: string, available: string[], suggestion?: string | null): string | null {
  return replacementCandidates(preferred, available, suggestion)[0] ?? null
}

/** Gemini 3 sets how hard it thinks by level, not by a token budget, and
 * cannot have thinking switched off: a request carrying the 2.5 models'
 * `thinkingBudget: 0` is refused (400). */
export function usesThinkingLevel(model: string): boolean {
  return modelVersion(model) >= 3
}

/** The level that stands for a 2.5-style budget: off / small -> low. */
export function thinkingLevelFor(budget: number): 'low' | 'medium' | 'high' {
  return budget >= 8192 ? 'high' : budget > 1024 ? 'medium' : 'low'
}

/** Output tokens to add when a budget of 0 (no thinking) became 'low':
 * the thinking is counted against the answer's own limit. */
export const THINKING_LEVEL_HEADROOM = 4096

/** A 400 about the thinking settings themselves (budget or level) -- or
 * Google's bare "Request contains an invalid argument", which is all a
 * Gemini 3 Lite model says to a 2.5-style budget. */
export function isThinkingConfigError(text: string): boolean {
  return /thinking[\s_]?(budget|level|config)|thinking is not|only works in thinking mode|request contains an invalid argument/i.test(text)
}

/** How long Google says to wait ("Please retry in 9h33m32.3s",
 * "retryDelay": "34s"), in ms; null when it does not say. */
export function quotaRetryMs(text: string): number | null {
  const m = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(text)
  if (m && (m[1] || m[2] || m[3])) return Math.ceil((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000)
  const d = /retry ?delay\W+(\d+(?:\.\d+)?)s/i.exec(text)
  return d ? Math.ceil(Number(d[1]) * 1000) : null
}

/** A key's quota for ONE model is used up for the day (the free tier gives
 * each model its own small daily count): waiting a minute will not help,
 * another model will. */
export function isDailyQuotaError(text: string): boolean {
  if (!/RESOURCE_EXHAUSTED|quota|429/i.test(text)) return false
  if (/per ?day|daily/i.test(text)) return true
  const wait = quotaRetryMs(text)
  return wait !== null && wait > 10 * 60 * 1000
}

/** Google's "this model is overloaded right now" (503). */
export function isBusyModelError(text: string): boolean {
  return /high demand|overloaded|UNAVAILABLE|503/i.test(text)
}

/** Every model that can stand in for `preferred` when it is retired, out of
 * quota for the day or overloaded, best first (replacementCandidates).
 * Never a Lite model: tried with a real key, Gemini 3.5 Flash Lite wrote
 * Khmer with Thai letters and stray characters in it -- no answer is
 * better than that one. */
export function fallbackModels(preferred: string, available: string[], suggestion?: string | null): string[] {
  return replacementCandidates(preferred, available, suggestion)
}
