import { app, ipcMain, type BrowserWindow } from 'electron'
import { createPublicKey, createHash, verify as cryptoVerify } from 'crypto'
import { execFile } from 'child_process'
import { hostname, userInfo, cpus } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import {
  LICENSE_IPC,
  parseLicenseKey,
  evaluateLicense,
  requireOnlineVerdict,
  formatMachineId,
  type LicenseState,
  type LicenseStatus,
  type ActivateLicenseResult,
  type ServerVerdict
} from '@shared/license'
import { LICENSE_PUBLIC_KEY_SPKI_BASE64 } from '@shared/licensePublicKey'
import { LICENSE_SERVER_URL, LICENSE_CHECKIN_INTERVAL_MS } from '@shared/licenseServer'
import { registerDevice, startDeviceHeartbeat, getCachedDeviceVerdict, clearDeviceVerdict } from './deviceLicense'
import type { DeviceVerdict } from '@shared/license'

/** Verifies the signed key locally, then requires this session's backend
 * check-in before the editor can open. No cached disk verdict can unlock it. */

function licenseFilePath(): string {
  return join(app.getPath('userData'), 'license.json')
}

export function verifyLicenseSignature(payloadBytes: Uint8Array, signature: Uint8Array, publicKeySpkiBase64 = LICENSE_PUBLIC_KEY_SPKI_BASE64): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    // WebCrypto (the admin panel) signs ECDSA as raw r||s, which Node calls
    // ieee-p1363 -- its default DER would reject every key the panel makes.
    return cryptoVerify('sha256', Buffer.from(payloadBytes), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature))
  } catch {
    return false
  }
}

/** A stable id for this computer: the Windows MachineGuid (survives
 * renames and user changes) hashed with nothing else identifying, falling
 * back to hostname+user+CPU where the registry can't be read. Shown as
 * `XXXX-XXXX-XXXX-XXXX`, which is what the user sends to get a key. */
let cachedMachineId: string | null = null
export async function getMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId
  const seed = (await readWindowsMachineGuid()) ?? `${hostname()}|${userInfo().username}|${cpus()[0]?.model ?? ''}`
  const digest = createHash('sha256').update(`creative-ai-editor-machine::${seed}`).digest('hex')
  cachedMachineId = formatMachineId(digest)
  return cachedMachineId
}

function readWindowsMachineGuid(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(stdout)
      resolve(match ? match[1].toLowerCase() : null)
    })
  })
}

interface StoredLicense {
  key: string
  activatedAt?: string
}

/** Deliberately memory-only: every app launch must contact the backend. */
let sessionApproval: { key: string; verdict: ServerVerdict } | null = null

async function readStored(): Promise<StoredLicense | null> {
  const path = licenseFilePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<StoredLicense>
    return typeof parsed.key === 'string' ? { key: parsed.key, activatedAt: parsed.activatedAt } : null
  } catch {
    return null
  }
}

async function writeStored(stored: StoredLicense): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(licenseFilePath(), JSON.stringify(stored, null, 2))
}

/** Which server to check in with. Both development and packaged builds use
 * the embedded production HTTPS URL by default, so starting through VS Code
 * cannot silently point a real license at an absent localhost server. A
 * developer can still opt into a local server explicitly with
 * CAE_LICENSE_SERVER=http://127.0.0.1:8787. */
export function licenseServerUrl(): string {
  // A packaged client must not be able to redirect checks to a fake server
  // by setting an environment variable. Embed the production URL at build.
  const configured = app.isPackaged
    ? LICENSE_SERVER_URL
    : (process.env.CAE_LICENSE_SERVER ?? LICENSE_SERVER_URL)
  const raw = configured
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return ''
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** One check-in. Null means no usable backend verdict and must fail closed. */
export async function checkInWithServer(licenseId: string, machineId: string, fetchImpl: typeof fetch = fetch): Promise<ServerVerdict | null> {
  const base = licenseServerUrl()
  if (!base) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    let res: Response
    try {
      res = await fetchImpl(`${base}/api/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseId, machineId, appVersion: app.getVersion() }),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return null
    const json = (await res.json()) as Partial<ServerVerdict>
    if (!json || typeof json.status !== 'string') return null
    if (!['active', 'expired', 'revoked', 'machine-mismatch', 'unknown'].includes(json.status)) return null
    return { status: json.status, expiresAt: json.expiresAt, message: json.message, checkedAt: json.checkedAt ?? new Date().toISOString() }
  } catch {
    return null
  }
}

/** The full verdict for a key on this machine, signature included. */
export function checkLicenseKey(rawKey: string, machineId: string, now: Date = new Date()): LicenseState {
  const parsed = parseLicenseKey(rawKey)
  if (!parsed.ok) return { state: 'invalid', reason: parsed.reason }
  if (!verifyLicenseSignature(parsed.key.payloadBytes, parsed.key.signature)) {
    return { state: 'invalid', reason: 'This key was not issued for this app (signature check failed).' }
  }
  return evaluateLicense(parsed.key.payload, machineId, now)
}

/** Turns the server's verdict about this computer into the gate's state. */
export function deviceLicenseState(verdict: DeviceVerdict): LicenseState {
  switch (verdict.status) {
    case 'active':
      return { state: 'device-approved', daysLeft: verdict.daysLeft, expiresAt: verdict.expiresAt }
    case 'blocked':
      return { state: 'blocked', message: verdict.message ?? 'The seller has turned off access for this computer.' }
    case 'expired':
      return { state: 'device-expired', expiredAt: verdict.expiresAt }
    default:
      return { state: 'pending-approval', requestedAt: verdict.checkedAt }
  }
}

/** Every launch checks the backend. During this running session, the last
 * active response is reused until the periodic forced refresh.
 *
 * Two ways in, checked in this order: a signed key the user pasted (the
 * original flow, kept working), or -- with no key -- this computer's own
 * registration with the server, which the admin grants days to (see
 * deviceLicense.ts). Neither can be satisfied from disk alone. */
export async function getLicenseStatus(forceOnline = false): Promise<LicenseStatus> {
  const machineId = await getMachineId()
  const stored = await readStored()
  const offline: LicenseState = stored ? checkLicenseKey(stored.key, machineId) : { state: 'none' }
  if (!stored || offline.state !== 'valid') {
    sessionApproval = null
    // No usable key: this computer asks for itself.
    const base = licenseServerUrl()
    if (base) {
      // Always a live call, never the cached verdict: this is the only
      // thing standing between a waiting user and the editor, so an
      // approval granted a second ago must show up on the next ask.
      const verdict = (await registerDevice(base, machineId)) ?? getCachedDeviceVerdict()
      if (verdict) {
        return {
          license: deviceLicenseState(verdict),
          machineId,
          appVersion: app.getVersion(),
          serverCheckedAt: verdict.checkedAt
        }
      }
      // Unreachable server: say so rather than showing a bare "no key".
      if (offline.state === 'none') {
        return {
          license: { state: 'verification-required', reason: 'Could not reach the licence server. Check the internet connection and try again.' },
          machineId,
          appVersion: app.getVersion()
        }
      }
    }
    return { license: offline, machineId, appVersion: app.getVersion() }
  }
  const server = !forceOnline && sessionApproval?.key === stored.key
    ? sessionApproval.verdict
    : await checkInWithServer(offline.payload.id, machineId)
  // A key can be changed/deactivated while the network request is pending.
  if ((await readStored())?.key !== stored.key) return getLicenseStatus(forceOnline)
  const license = requireOnlineVerdict(offline, server)
  sessionApproval = license.state === 'valid' && server ? { key: stored.key, verdict: server } : null
  return { license, machineId, appVersion: app.getVersion(), serverCheckedAt: server?.checkedAt }
}

function describeFailure(verdict: LicenseState, machineId: string): string {
  switch (verdict.state) {
    case 'invalid':
      return verdict.reason
    case 'verification-required':
      return verdict.reason
    case 'expired':
      return `This key expired on ${verdict.expiredAt.slice(0, 10)}. Ask for a renewed key.`
    case 'wrong-machine':
      return `This key was issued for a different computer. Send your Machine ID (${machineId}) to get one for this machine.`
    case 'revoked':
      return verdict.message
    default:
      return 'No key.'
  }
}

export async function activateLicense(rawKey: string): Promise<ActivateLicenseResult> {
  const machineId = await getMachineId()
  const key = rawKey.replace(/\s+/g, '')
  const offline = checkLicenseKey(key, machineId)
  if (offline.state !== 'valid') {
    return { ok: false, error: describeFailure(offline, machineId), status: { license: offline, machineId, appVersion: app.getVersion() } }
  }
  // Keep a valid signed key so the user can retry after a network outage,
  // but never grant access until the backend confirms it is active.
  sessionApproval = null
  await writeStored({ key, activatedAt: new Date().toISOString() })
  const status = await getLicenseStatus(true)
  if (status.license.state !== 'valid') {
    return { ok: false, error: describeFailure(status.license, machineId), status }
  }
  return { ok: true, status }
}

export async function deactivateLicense(): Promise<LicenseStatus> {
  sessionApproval = null
  clearDeviceVerdict()
  await unlink(licenseFilePath()).catch(() => undefined)
  return getLicenseStatus()
}

/** Re-check while running. Losing backend access closes the editor gate. */
export async function refreshFromServer(notify: (status: LicenseStatus) => void): Promise<void> {
  const stored = await readStored()
  if (!stored) return
  notify(await getLicenseStatus(true))
}

export function registerLicenseIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(LICENSE_IPC.getStatus, () => getLicenseStatus())
  ipcMain.handle(LICENSE_IPC.activate, (_event, rawKey: string) => activateLicense(String(rawKey ?? '')))
  ipcMain.handle(LICENSE_IPC.deactivate, () => deactivateLicense())

  const notify = (status: LicenseStatus): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(LICENSE_IPC.statusChanged, status)
  }
  // The gate's first status read blocks on a live backend check-in.
  setInterval(() => void refreshFromServer(notify), LICENSE_CHECKIN_INTERVAL_MS)

  // ...and this computer re-announces itself every minute: it keeps the
  // Admin panel's "online" live, unlocks a waiting user the moment the
  // admin grants days (no restart), and locks a computer the admin turned
  // off within the minute.
  void getMachineId().then((machineId) => {
    startDeviceHeartbeat(licenseServerUrl(), machineId, () => {
      void getLicenseStatus().then(notify)
    })
  })
}
