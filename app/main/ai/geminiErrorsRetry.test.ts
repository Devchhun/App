import { describe, expect, it, vi } from 'vitest'

vi.mock('../media/jobRunner', () => ({ CanceledError: class CanceledError extends Error {} }))

import { isFatalGeminiError, isRateLimited, suggestedRetryDelayMs } from './geminiErrors'

const perMinute = new Error(
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}'
)
const perDay = new Error(
  '{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'
)

describe('Gemini limits', () => {
  it('waits out the per-minute limit, for as long as Gemini asks', () => {
    expect(isRateLimited(perMinute)).toBe(true)
    expect(isFatalGeminiError(perMinute)).toBe(false)
    expect(suggestedRetryDelayMs(perMinute)).toBe(37000)
  })
  it('stops on the day\'s quota, a bad key or no credits', () => {
    expect(isRateLimited(perDay)).toBe(false)
    expect(isFatalGeminiError(perDay)).toBe(true)
    expect(isFatalGeminiError(new Error('API key not valid. Please pass a valid API key. (API_KEY_INVALID)'))).toBe(true)
    expect(isFatalGeminiError(new Error('402 Your prepayment credits are depleted'))).toBe(true)
    expect(isFatalGeminiError(new Error('fetch failed | ECONNRESET'))).toBe(false)
  })
})
