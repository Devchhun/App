import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { encodeLicenseKey, utf8Encode, type LicensePayload } from '@shared/license'

let userDataDir: string
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const testPublicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test', isPackaged: true },
  ipcMain: { handle: () => undefined }
}))
vi.mock('@shared/licensePublicKey', () => ({ LICENSE_PUBLIC_KEY_SPKI_BASE64: testPublicKey }))

const payload: LicensePayload = {
  v: 1,
  id: 'online_test',
  name: 'Test User',
  machineId: '',
  plan: 'lifetime',
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null
}

function issueKey(): string {
  const bytes = utf8Encode(JSON.stringify(payload))
  return encodeLicenseKey(bytes, new Uint8Array(sign('sha256', Buffer.from(bytes), { key: privateKey, dsaEncoding: 'ieee-p1363' })))
}

function backend(status: string): Response {
  return { ok: true, json: async () => ({ status, checkedAt: new Date().toISOString() }) } as Response
}

beforeEach(async () => {
  vi.resetModules()
  userDataDir = await mkdtemp(join(tmpdir(), 'cae-online-license-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(userDataDir, { recursive: true, force: true })
})

describe('online-only license gate', () => {
  it('requires a fresh backend check at startup, then reuses it only for this session', async () => {
    await writeFile(join(userDataDir, 'license.json'), JSON.stringify({ key: issueKey() }))
    const fetchMock = vi.fn(async () => backend('active'))
    vi.stubGlobal('fetch', fetchMock)
    const { getLicenseStatus } = await import('./licenseStore')
    expect((await getLicenseStatus()).license.state).toBe('valid')
    expect((await getLicenseStatus()).license.state).toBe('valid')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not trust an active verdict cached in license.json when offline', async () => {
    await writeFile(join(userDataDir, 'license.json'), JSON.stringify({ key: issueKey(), server: { status: 'active', checkedAt: new Date().toISOString() } }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { getLicenseStatus } = await import('./licenseStore')
    expect((await getLicenseStatus()).license.state).toBe('verification-required')
  })

  it('rejects a signed key absent from the backend', async () => {
    await writeFile(join(userDataDir, 'license.json'), JSON.stringify({ key: issueKey() }))
    vi.stubGlobal('fetch', vi.fn(async () => backend('unknown')))
    const { getLicenseStatus } = await import('./licenseStore')
    expect((await getLicenseStatus()).license.state).toBe('verification-required')
  })

  it('closes the gate if a periodic backend recheck fails', async () => {
    await writeFile(join(userDataDir, 'license.json'), JSON.stringify({ key: issueKey() }))
    const fetchMock = vi.fn().mockResolvedValueOnce(backend('active')).mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { getLicenseStatus, refreshFromServer } = await import('./licenseStore')
    expect((await getLicenseStatus()).license.state).toBe('valid')
    const notify = vi.fn()
    await refreshFromServer(notify)
    expect(notify.mock.calls[0][0].license.state).toBe('verification-required')
    expect((await getLicenseStatus()).license.state).toBe('verification-required')
  })

  it('lets a user retry a stored signed key when the backend returns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { activateLicense, getLicenseStatus } = await import('./licenseStore')
    const activation = await activateLicense(issueKey())
    expect(activation.ok).toBe(false)
    expect(activation.status.license.state).toBe('verification-required')
    vi.stubGlobal('fetch', vi.fn(async () => backend('active')))
    expect((await getLicenseStatus()).license.state).toBe('valid')
  })
})
