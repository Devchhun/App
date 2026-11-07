import { describe, expect, it } from 'vitest'
import { isBusyModelError } from './geminiModels'
import { GeminiKeyPool, isPerMinuteQuotaError, isRefusedKeyError, maskGeminiKey, mergeGeminiKeys, parseGeminiKeys } from './geminiKeyPool'

const A = 'AQ.keyAAAAAAAAAAAAAAAAAAAAAAAA'
const B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBB-_'
const C = 'AQ.keyCCCCCCCCCCCCCCCCCCCCCCCC'

describe('parseGeminiKeys', () => {
  it('takes the keys out of an email + key list', () => {
    expect(parseGeminiKeys(`one@gmail.com\n${A} \r\ntwo@gmail.com\n${B}\n`)).toEqual([A, B])
  })

  it('reads keys separated by spaces or commas, once each', () => {
    expect(parseGeminiKeys(`${A}, ${B};${C} ${A}`)).toEqual([A, B, C])
  })

  it('finds nothing in text with no key', () => {
    expect(parseGeminiKeys('my key is here')).toEqual([])
    expect(parseGeminiKeys('')).toEqual([])
  })
})

describe('mergeGeminiKeys', () => {
  it('puts new keys first and drops repeats', () => {
    expect(mergeGeminiKeys([B, C], [A, B])).toEqual([B, C, A])
  })
})

describe('maskGeminiKey', () => {
  it('never shows the whole key', () => {
    expect(maskGeminiKey(A)).toBe('AQ.k…AAAA')
    expect(maskGeminiKey('')).toBe('')
  })
})

describe('errors', () => {
  it('knows a refused key, including a project with no free tier', () => {
    expect(isRefusedKeyError('{"error":{"code":400,"message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}')).toBe(true)
    expect(isRefusedKeyError('{"error":{"code":400,"message":"API key expired. Please renew the API key."}}')).toBe(true)
    expect(isRefusedKeyError('{"error":{"code":403,"message":"The Gemini API free tier is not available for this project. To use the Gemini API, please set up billing","status":"PERMISSION_DENIED"}}')).toBe(true)
  })

  it('does not take a refusal linking to project-unavailable for an overload', () => {
    const text = '{"error":{"code":403,"message":"free tier is not available for this project. see https://ai.google.dev/gemini-api/docs/troubleshooting#project-unavailable.","status":"PERMISSION_DENIED"}}'
    expect(isRefusedKeyError(text)).toBe(true)
    expect(isBusyModelError(text)).toBe(false)
    expect(isBusyModelError('{"error":{"code":503,"status":"UNAVAILABLE"}}')).toBe(true)
    expect(isBusyModelError('got status 503 from the server')).toBe(true)
  })

  it('does not blame the key for a file, a region or a quota', () => {
    expect(isRefusedKeyError('{"error":{"code":403,"message":"You do not have permission to access the File abc or it may not exist.","status":"PERMISSION_DENIED"}}')).toBe(false)
    expect(isRefusedKeyError('{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}')).toBe(false)
    expect(isRefusedKeyError('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(false)
  })

  it('tells a per-minute limit from a daily one', () => {
    expect(isPerMinuteQuotaError('429 RESOURCE_EXHAUSTED per minute. Please retry in 30s')).toBe(true)
    expect(isPerMinuteQuotaError('429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier')).toBe(false)
    expect(isPerMinuteQuotaError('503 UNAVAILABLE')).toBe(false)
  })
})

describe('GeminiKeyPool', () => {
  const pool = (): { pool: GeminiKeyPool; pass: (ms: number) => void } => {
    let now = 1000
    const made = new GeminiKeyPool(() => now)
    made.setKeys([A, B, C])
    return { pool: made, pass: (ms) => (now += ms) }
  }

  it('starts at the first key and stays on the one that works', () => {
    const { pool: p } = pool()
    expect(p.order()).toEqual([A, B, C])
    p.markWorking(B)
    expect(p.order()).toEqual([B, C, A])
    expect(p.best()).toBe(B)
  })

  it('moves on when a key is out, and takes it back when its time is up', () => {
    const { pool: p, pass } = pool()
    p.markWorking(A)
    p.markOut(A, 60_000)
    expect(p.order()).toEqual([B, C])
    expect(p.backAt(A)).toBe(61_000)
    pass(60_001)
    expect(p.order()).toEqual([A, B, C])
    expect(p.backAt(A)).toBeNull()
  })

  it('with every key out, offers them by which is back soonest', () => {
    const { pool: p } = pool()
    p.markOut(A, 3000)
    p.markOut(B, 1000)
    p.markOut(C, 2000)
    expect(p.order()).toEqual([B, C, A])
  })

  it('still uses a key it was never given', () => {
    const { pool: p } = pool()
    expect(p.order('unknown-key-1234')).toEqual(['unknown-key-1234', A, B, C])
  })

  it('forgets keys that were removed and keeps what it knows of the others', () => {
    const { pool: p } = pool()
    p.markOut(B, 60_000)
    p.markWorking(C)
    p.setKeys([A, B])
    expect(p.order()).toEqual([A])
    expect(p.backAt(B)).not.toBeNull()
  })
})
