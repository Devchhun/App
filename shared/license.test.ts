import { describe, it, expect } from 'vitest'
import {
  bytesToBase64Url,
  base64UrlToBytes,
  encodeLicenseKey,
  parseLicenseKey,
  evaluateLicense,
  applyServerVerdict,
  requireOnlineVerdict,
  formatMachineId,
  normalizeMachineId,
  utf8Encode,
  type LicensePayload
} from './license'

const payload: LicensePayload = {
  v: 1,
  id: 'lic_1',
  name: 'Sok Dara',
  contact: '012 345 678',
  machineId: 'AB12-CD34-EF56-7890',
  plan: 'standard',
  issuedAt: '2026-09-13T00:00:00.000Z',
  expiresAt: '2027-09-13T00:00:00.000Z'
}
const fakeSig = new Uint8Array(64).fill(7)

describe('base64url', () => {
  it('round-trips every byte value without padding characters', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const text = bytesToBase64Url(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect(Array.from(base64UrlToBytes(text))).toEqual(Array.from(bytes))
  })
})

describe('parseLicenseKey', () => {
  it('decodes what encodeLicenseKey wrote, ignoring pasted whitespace', () => {
    const key = encodeLicenseKey(utf8Encode(JSON.stringify(payload)), fakeSig)
    const wrapped = key.slice(0, 40) + '\n  ' + key.slice(40, 90) + ' ' + key.slice(90)
    const parsed = parseLicenseKey(wrapped)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.key.payload).toEqual(payload)
    expect(Array.from(parsed.key.signature)).toEqual(Array.from(fakeSig))
  })

  it('rejects keys for other products, truncated keys, and mangled payloads', () => {
    expect(parseLicenseKey('XYZ1.abc.def').ok).toBe(false)
    expect(parseLicenseKey('').ok).toBe(false)
    const key = encodeLicenseKey(utf8Encode(JSON.stringify(payload)), fakeSig)
    expect(parseLicenseKey(key.slice(0, -10)).ok).toBe(false)
    const badPayload = encodeLicenseKey(utf8Encode('{"v":1,"id":"x"}'), fakeSig)
    expect(parseLicenseKey(badPayload).ok).toBe(false)
  })
})

describe('evaluateLicense', () => {
  const now = new Date('2026-10-01T00:00:00.000Z')

  it('is valid on the right machine before expiry, counting the days left', () => {
    const state = evaluateLicense(payload, 'ab12cd34ef567890', now)
    expect(state.state).toBe('valid')
    if (state.state === 'valid') expect(state.daysLeft).toBe(347)
  })

  it('refuses a different machine', () => {
    expect(evaluateLicense(payload, 'FFFF-FFFF-FFFF-FFFF', now).state).toBe('wrong-machine')
  })

  it('works on any machine when the key is not tied to one', () => {
    expect(evaluateLicense({ ...payload, machineId: '' }, 'FFFF-FFFF-FFFF-FFFF', now).state).toBe('valid')
  })

  it('expires at the exact expiry instant, and never for lifetime keys', () => {
    expect(evaluateLicense(payload, payload.machineId!, new Date(payload.expiresAt!)).state).toBe('expired')
    const forever = evaluateLicense({ ...payload, plan: 'lifetime', expiresAt: null }, payload.machineId!, new Date('2099-01-01'))
    expect(forever.state).toBe('valid')
    if (forever.state === 'valid') expect(forever.daysLeft).toBeNull()
  })
})

describe('machine ids', () => {
  it('formats a digest into four groups and compares ignoring case and dashes', () => {
    expect(formatMachineId('ab12cd34ef567890ffff')).toBe('AB12-CD34-EF56-7890')
    expect(normalizeMachineId('ab12-cd34')).toBe(normalizeMachineId('AB12CD34'))
  })
})

describe('applyServerVerdict', () => {
  const now = new Date('2026-10-01T00:00:00.000Z')
  const valid = evaluateLicense(payload, payload.machineId!, now)
  const checkedAt = now.toISOString()

  it('leaves the signed verdict alone when the server is silent or has never heard of the key', () => {
    expect(applyServerVerdict(valid, null, now)).toEqual(valid)
    expect(applyServerVerdict(valid, { status: 'unknown', checkedAt }, now)).toEqual(valid)
  })

  it('a revocation locks a key that still verifies', () => {
    const state = applyServerVerdict(valid, { status: 'revoked', message: 'Chargeback.', checkedAt }, now)
    expect(state.state).toBe('revoked')
    if (state.state === 'revoked') expect(state.message).toBe('Chargeback.')
  })

  it('the server can shorten a license (expire, re-bind) but never talk a bad key into validity', () => {
    expect(applyServerVerdict(valid, { status: 'expired', expiresAt: '2026-09-30T00:00:00.000Z', checkedAt }, now).state).toBe('expired')
    expect(applyServerVerdict(valid, { status: 'machine-mismatch', checkedAt }, now).state).toBe('wrong-machine')
    const invalid = { state: 'invalid' as const, reason: 'bad signature' }
    expect(applyServerVerdict(invalid, { status: 'active', checkedAt }, now)).toEqual(invalid)
  })

  it('a cached active verdict cannot extend an expired signed key', () => {
    const expired = evaluateLicense(payload, payload.machineId!, new Date('2028-01-01'))
    expect(expired.state).toBe('expired')
    const state = applyServerVerdict(expired, { status: 'active', expiresAt: '2029-01-01T00:00:00.000Z', checkedAt }, new Date('2028-01-01'))
    expect(state.state).toBe('expired')
  })

  it('a cached active verdict cannot override the signed expiry with a later date or lifetime', () => {
    const later = new Date('2026-10-01')
    const future = '2099-01-01T00:00:00.000Z'
    expect(applyServerVerdict(valid, { status: 'active', expiresAt: future, checkedAt }, later)).toEqual(valid)
    expect(applyServerVerdict(valid, { status: 'active', expiresAt: null, checkedAt }, later)).toEqual(valid)
  })

  it('a stale "active" answer cannot keep an expired key alive past its date', () => {
    const later = new Date('2028-01-01')
    const expired = evaluateLicense(payload, payload.machineId!, later)
    expect(applyServerVerdict(expired, { status: 'active', expiresAt: payload.expiresAt, checkedAt }, later).state).toBe('expired')
  })
})

describe('requireOnlineVerdict', () => {
  const offline = evaluateLicense(payload, payload.machineId!, new Date('2026-10-01'))
  const checkedAt = '2026-10-01T00:00:00.000Z'

  it('keeps the editor locked when the backend is unavailable or does not know the key', () => {
    expect(requireOnlineVerdict(offline, null).state).toBe('verification-required')
    expect(requireOnlineVerdict(offline, { status: 'unknown', checkedAt }).state).toBe('verification-required')
  })

  it('opens only for an active backend response and still respects the signed key', () => {
    expect(requireOnlineVerdict(offline, { status: 'active', checkedAt }, new Date('2026-10-01')).state).toBe('valid')
    expect(requireOnlineVerdict(offline, { status: 'revoked', checkedAt }).state).toBe('revoked')
    const expired = evaluateLicense(payload, payload.machineId!, new Date('2028-01-01'))
    expect(requireOnlineVerdict(expired, { status: 'active', checkedAt }, new Date('2028-01-01')).state).toBe('expired')
  })
})
