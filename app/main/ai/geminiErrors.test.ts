import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { describeError, explainGeminiError, isRetryableError } = await import('./geminiErrors')
const { CanceledError } = await import('../media/jobRunner')

/** What Node's fetch actually throws: the useful part lives in `cause`. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code} generativelanguage.googleapis.com`), { code })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

describe('describeError', () => {
  it('surfaces the hidden cause behind "fetch failed"', () => {
    expect(describeError(fetchFailed('ECONNRESET'))).toBe('fetch failed | connect ECONNRESET generativelanguage.googleapis.com | ECONNRESET')
  })
})

describe('isRetryableError', () => {
  it('says plainly when the prepaid credits are used up (waiting will not help)', () => {
    const real = new Error('{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}')
    expect(explainGeminiError(real)).toMatch(/^លុយ \(Credit\) ក្នុង Gemini API Key អស់ហើយ/)
    expect(explainGeminiError(real)).not.toContain('រង់ចាំបន្តិច')
    expect(isRetryableError(real)).toBe(false)
    // A per-minute limit is still the quota message.
    expect(explainGeminiError(new Error('429 RESOURCE_EXHAUSTED: rate limit'))).toMatch(/^Gemini quota អស់/)
  })

  it('tells a busy server apart from a broken connection', () => {
    expect(explainGeminiError(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'))).toMatch(/^Gemini កំពុងរវល់ខ្លាំង/)
    expect(explainGeminiError(new Error('fetch failed'))).toMatch(/^តភ្ជាប់ទៅ Gemini មិនបាន/)
  })

  it('retries dropped connections and an overloaded server', () => {
    expect(isRetryableError(fetchFailed('ECONNRESET'))).toBe(true)
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableError(new Error('got status: 503 Service Unavailable'))).toBe(true)
  })

  it('does not retry an exhausted quota, a bad key, or a cancel', () => {
    expect(isRetryableError(new Error('got status: 429 RESOURCE_EXHAUSTED'))).toBe(false)
    expect(isRetryableError(new Error('API key not valid. Please pass a valid API key.'))).toBe(false)
    expect(isRetryableError(new CanceledError())).toBe(false)
  })

  it('does not retry an unrelated failure', () => {
    expect(isRetryableError(new Error('Gemini transcription was truncated for this audio part.'))).toBe(false)
  })
})

describe('explainGeminiError', () => {
  it('tells the user a network drop is a connection problem, not a quota one', () => {
    const text = explainGeminiError(fetchFailed('ETIMEDOUT'))
    expect(text).toContain('តភ្ជាប់ទៅ Gemini មិនបាន')
    expect(text).toContain('fetch failed')
  })

  it('names quota and key problems plainly', () => {
    expect(explainGeminiError(new Error('429 RESOURCE_EXHAUSTED'))).toContain('Gemini quota')
    expect(explainGeminiError(new Error('API key not valid'))).toContain('Settings > AI API Keys')
  })

  it('passes any other message through unchanged', () => {
    expect(explainGeminiError(new Error('Gemini transcription was truncated for this audio part.'))).toBe('Gemini transcription was truncated for this audio part.')
  })
})
