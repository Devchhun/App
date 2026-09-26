import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { encodeLicenseKey, utf8Encode, type LicensePayload } from '@shared/license'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => undefined }
}))

// A throwaway keypair per test file, so the tests never depend on (or
// leak) the real signing key -- the store is pointed at this public key
// explicitly through verifyLicenseSignature's parameter.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PUBLIC_SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

function issue(payload: LicensePayload): string {
  const bytes = utf8Encode(JSON.stringify(payload))
  const signature = sign('sha256', Buffer.from(bytes), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return encodeLicenseKey(bytes, new Uint8Array(signature))
}

const payload: LicensePayload = {
  v: 1,
  id: 'lic_test',
  name: 'Test User',
  machineId: '',
  plan: 'lifetime',
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cae-license-test-'))
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('verifyLicenseSignature', () => {
  it('accepts a key signed by the matching private key (raw r||s signature, as WebCrypto produces)', async () => {
    const { verifyLicenseSignature } = await import('./licenseStore')
    const bytes = utf8Encode(JSON.stringify(payload))
    const signature = sign('sha256', Buffer.from(bytes), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    expect(verifyLicenseSignature(bytes, new Uint8Array(signature), PUBLIC_SPKI)).toBe(true)
  })

  it('rejects a payload edited after signing -- extending your own expiry does not work', async () => {
    const { verifyLicenseSignature } = await import('./licenseStore')
    const bytes = utf8Encode(JSON.stringify(payload))
    const signature = sign('sha256', Buffer.from(bytes), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    const edited = utf8Encode(JSON.stringify({ ...payload, name: 'Someone Else' }))
    expect(verifyLicenseSignature(edited, new Uint8Array(signature), PUBLIC_SPKI)).toBe(false)
  })

  it('rejects a key signed by some other private key', async () => {
    const { verifyLicenseSignature } = await import('./licenseStore')
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    const bytes = utf8Encode(JSON.stringify(payload))
    const signature = sign('sha256', Buffer.from(bytes), { key: other, dsaEncoding: 'ieee-p1363' })
    expect(verifyLicenseSignature(bytes, new Uint8Array(signature), PUBLIC_SPKI)).toBe(false)
  })
})

describe('checkLicenseKey against the app\'s real public key', () => {
  it('reports a key from an unknown signer as invalid with a signature reason', async () => {
    const { checkLicenseKey } = await import('./licenseStore')
    const state = checkLicenseKey(issue(payload), 'AAAA-BBBB-CCCC-DDDD')
    expect(state.state).toBe('invalid')
    if (state.state === 'invalid') expect(state.reason).toMatch(/signature/)
  })

  it('reports garbage as invalid without throwing', async () => {
    const { checkLicenseKey } = await import('./licenseStore')
    expect(checkLicenseKey('hello', 'AAAA').state).toBe('invalid')
  })
})

describe('checkInWithServer', () => {
  const okResponse = (body: unknown): Response => ({ ok: true, json: async () => body }) as unknown as Response

  it('uses the production HTTPS server by default in development too', async () => {
    delete process.env.CAE_LICENSE_SERVER
    const { licenseServerUrl } = await import('./licenseStore')
    expect(licenseServerUrl()).toBe('https://lifsten-server.host.wordmerl.online')
  })

  it('is a no-op without a configured server', async () => {
    process.env.CAE_LICENSE_SERVER = ''
    const { checkInWithServer } = await import('./licenseStore')
    const fetchImpl = vi.fn()
    expect(await checkInWithServer('lic_1', 'AAAA', fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    delete process.env.CAE_LICENSE_SERVER
  })

  it('posts the license and machine to /api/checkin and returns the verdict', async () => {
    process.env.CAE_LICENSE_SERVER = 'https://license.example.com/'
    const { checkInWithServer } = await import('./licenseStore')
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ status: 'revoked', message: 'Cancelled.', checkedAt: '2026-09-14T00:00:00Z' }))
    const verdict = await checkInWithServer('lic_1', 'AAAA-BBBB', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://license.example.com/api/checkin')
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toMatchObject({ licenseId: 'lic_1', machineId: 'AAAA-BBBB', appVersion: '0.0.0-test' })
    expect(verdict).toMatchObject({ status: 'revoked', message: 'Cancelled.' })
    delete process.env.CAE_LICENSE_SERVER
  })

  it('treats network failure, HTTP errors and nonsense answers as silence', async () => {
    process.env.CAE_LICENSE_SERVER = 'https://license.example.com'
    const { checkInWithServer } = await import('./licenseStore')
    expect(await checkInWithServer('lic_1', 'A', vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
    expect(await checkInWithServer('lic_1', 'A', vi.fn(async () => ({ ok: false }) as Response) as unknown as typeof fetch)).toBeNull()
    expect(await checkInWithServer('lic_1', 'A', vi.fn(async () => okResponse({ status: 'banana' })) as unknown as typeof fetch)).toBeNull()
    delete process.env.CAE_LICENSE_SERVER
  })

  it('refuses insecure remote URLs and URLs with embedded credentials', async () => {
    const { licenseServerUrl } = await import('./licenseStore')
    process.env.CAE_LICENSE_SERVER = 'http://license.example.com'
    expect(licenseServerUrl()).toBe('')
    process.env.CAE_LICENSE_SERVER = 'https://admin:secret@license.example.com'
    expect(licenseServerUrl()).toBe('')
    process.env.CAE_LICENSE_SERVER = 'http://127.0.0.1:8787/'
    expect(licenseServerUrl()).toBe('http://127.0.0.1:8787')
    delete process.env.CAE_LICENSE_SERVER
  })

  it('does not trust a runtime server override in a packaged app', async () => {
    const { app } = await import('electron')
    const { licenseServerUrl } = await import('./licenseStore')
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
    process.env.CAE_LICENSE_SERVER = 'https://attacker.example'
    try {
      expect(licenseServerUrl()).toBe('https://lifsten-server.host.wordmerl.online')
    } finally {
      delete process.env.CAE_LICENSE_SERVER
      Reflect.deleteProperty(app, 'isPackaged')
    }
  })
})
