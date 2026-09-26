import { CanceledError } from '../media/jobRunner'

/** Node's fetch reports every transport problem -- DNS, a dropped Wi-Fi
 * link, a proxy closing the socket mid-upload -- as the same opaque
 * "fetch failed", with the real reason hidden in error.cause. Flatten the
 * chain so it can be classified and shown to the user. */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    parts.push(current.message)
    const code = (current as NodeJS.ErrnoException).code
    if (code) parts.push(code)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length ? parts.join(' | ') : String(error)
}

const NETWORK_PATTERN = /fetch failed|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up|network|terminated|timed? ?out/i
const OVERLOAD_PATTERN = /\b(500|502|503|504)\b|unavailable|overloaded|high demand|internal error|deadline/i
const QUOTA_PATTERN = /resource_exhausted|quota|billing|\b429\b|rate.?limit/i
/** Out of money, not out of breath: prepaid credits used up (HTTP 402).
 * Waiting does not help -- only topping up the project does. */
const CREDITS_PATTERN = /\b402\b|prepayment credits|credits are depleted|insufficient (?:funds|credits|balance)/i
const KEY_PATTERN = /api key|api_key_invalid|permission_denied|unauthenticated|\b401\b|\b403\b/i

/** A failure worth trying again: the request never reached a verdict. A bad
 * key or an exhausted quota is not retried -- repeating it only wastes time
 * and, for quota, makes the wait longer. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof CanceledError) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  const text = describeError(error)
  if (CREDITS_PATTERN.test(text) || QUOTA_PATTERN.test(text) || KEY_PATTERN.test(text)) return false
  return NETWORK_PATTERN.test(text) || OVERLOAD_PATTERN.test(text)
}

/** Turns an opaque SDK failure into something the user can act on. The raw
 * text stays in parentheses so the real cause is never hidden. */
export function explainGeminiError(error: unknown): string {
  if (error instanceof CanceledError) return 'Canceled'
  const text = describeError(error)
  if (CREDITS_PATTERN.test(text)) {
    return `លុយ (Credit) ក្នុង Gemini API Key អស់ហើយ — ការរង់ចាំមិនជួយទេ។ សូមបញ្ចូលលុយ (Top up) នៅ AI Studio (https://ai.studio/projects → Billing) ឬប្តូរទៅ API key ផ្សេងនៅ Settings > AI API Keys។ (${text})`
  }
  if (QUOTA_PATTERN.test(text)) {
    return `Gemini quota អស់ ឬប្រើលើសកំណត់ក្នុងមួយនាទី — រង់ចាំបន្តិចរួចសាកម្តងទៀត ឬប្តូរទៅ API key/Plan ផ្សេង។ (${text})`
  }
  if (KEY_PATTERN.test(text)) {
    return `Gemini API key មិនត្រឹមត្រូវ ឬគ្មានសិទ្ធិ — ពិនិត្យនៅ Settings > AI API Keys។ (${text})`
  }
  // Gemini answered, but is too busy: the internet is fine, so say so.
  if (OVERLOAD_PATTERN.test(text) && !NETWORK_PATTERN.test(text)) {
    return `Gemini កំពុងរវល់ខ្លាំង (Server របស់ Google ពេញ) — មិនមែនបញ្ហាអ៊ីនធឺណិតទេ។ រង់ចាំ ១-២ នាទី រួចចុចម្តងទៀត។ (${text})`
  }
  if (NETWORK_PATTERN.test(text)) {
    return `តភ្ជាប់ទៅ Gemini មិនបាន (បានព្យាយាមឡើងវិញរួចហើយ) — ពិនិត្យអ៊ីនធឺណិត ឬ VPN រួចចុចម្តងទៀត។ (${text})`
  }
  return text
}

export async function sleepUnlessCanceled(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new CanceledError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new CanceledError()) }, { once: true })
  })
}
