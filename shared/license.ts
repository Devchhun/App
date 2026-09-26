// License keys: what one says, how it's written down, and whether it is
// valid right now -- everything that does NOT need a private key or the
// filesystem, so the renderer, the main process and the admin panel all
// agree on the format from one definition.
//
// A key is `CAE1.<payload>.<signature>` (base64url, no padding): the JSON
// LicensePayload, and an ECDSA P-256/SHA-256 signature over exactly those
// payload bytes, made by the admin panel's private key. The app carries only
// the matching public key (licensePublicKey.ts), so a key can be checked
// fully offline and nobody can mint one without the private half. Opening
// the editor additionally requires a fresh, active backend check-in each
// session; a signed key by itself is not sufficient.

export const LICENSE_KEY_PREFIX = 'CAE1'

export type LicensePlan = 'trial' | 'standard' | 'lifetime'

export interface LicensePayload {
  v: 1
  /** Stable id of this issued key -- what the admin panel lists it under. */
  id: string
  /** Who it was issued to (display only). */
  name: string
  /** Phone / Telegram / email -- display only. */
  contact?: string
  /** The one machine this key works on (see machineId in the app's License
   * settings), or empty for a key that works anywhere. */
  machineId?: string
  plan: LicensePlan
  /** ISO timestamps. `expiresAt` null = never expires. */
  issuedAt: string
  expiresAt: string | null
}

/** What the server says about THIS computer (see license-server's
 * /api/device/register): the "seller grants days to a machine" flow, with
 * no key to issue or paste. */
export interface DeviceVerdict {
  status: 'pending' | 'active' | 'expired' | 'blocked'
  expiresAt: string | null
  /** Days remaining; null with `active` means unlimited. */
  daysLeft: number | null
  message?: string
  checkedAt: string
}

export type LicenseState =
  | { state: 'none' }
  /** Registered with the server, waiting for the admin to grant days. */
  | { state: 'pending-approval'; requestedAt: string }
  /** The admin turned this computer off. */
  | { state: 'blocked'; message: string }
  /** The granted days ran out. */
  | { state: 'device-expired'; expiredAt: string | null }
  /** Approved by the admin for this machine -- `daysLeft` null = unlimited. */
  | { state: 'device-approved'; daysLeft: number | null; expiresAt: string | null }
  | { state: 'invalid'; reason: string }
  | { state: 'verification-required'; reason: string }
  | { state: 'expired'; payload: LicensePayload; expiredAt: string }
  | { state: 'wrong-machine'; payload: LicensePayload }
  | { state: 'revoked'; payload: LicensePayload; message: string }
  | { state: 'valid'; payload: LicensePayload; daysLeft: number | null }

/** What the license server said about this key (license-server/lib.js's
 * /api/checkin). A disk-cached verdict must never unlock the editor. */
export interface ServerVerdict {
  status: 'active' | 'expired' | 'revoked' | 'machine-mismatch' | 'unknown'
  expiresAt?: string | null
  message?: string
  checkedAt: string
}

/** What the renderer gets: the verdict plus this machine's own id, which is
 * what the user sends the admin to get a key issued. */
export interface LicenseStatus {
  license: LicenseState
  machineId: string
  appVersion: string
  /** When the server was last reached, if a server is configured at all. */
  serverCheckedAt?: string
}

export const LICENSE_IPC = {
  getStatus: 'license:get-status',
  activate: 'license:activate',
  deactivate: 'license:deactivate',
  /** main -> renderer, after a background check-in changed the verdict. */
  statusChanged: 'license:status-changed'
} as const

export type ActivateLicenseResult = { ok: true; status: LicenseStatus } | { ok: false; error: string; status: LicenseStatus }

// --- base64url without Buffer, so this file runs in the renderer too -----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const triple = (a << 16) | (b << 8) | c
    out += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : ''
    out += i + 2 < bytes.length ? B64[triple & 63] : ''
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_')
}

export function base64UrlToBytes(text: string): Uint8Array {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const value = B64.indexOf(ch)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

// --- key format ------------------------------------------------------------

export interface ParsedLicenseKey {
  payload: LicensePayload
  /** The exact bytes the signature covers. */
  payloadBytes: Uint8Array
  signature: Uint8Array
}

/** Splits and decodes a key WITHOUT checking its signature -- that needs
 * the public key and platform crypto (app/main/license/licenseStore.ts).
 * Whitespace and line breaks (a key pasted from a chat) are tolerated. */
export function parseLicenseKey(raw: string): { ok: true; key: ParsedLicenseKey } | { ok: false; reason: string } {
  const text = raw.replace(/\s+/g, '')
  if (!text) return { ok: false, reason: 'Enter a license key.' }
  const parts = text.split('.')
  if (parts.length !== 3 || parts[0] !== LICENSE_KEY_PREFIX) {
    return { ok: false, reason: 'That is not a Creative AI Editor license key (it should start with CAE1.).' }
  }
  const payloadBytes = base64UrlToBytes(parts[1])
  const signature = base64UrlToBytes(parts[2])
  if (signature.length !== 64) return { ok: false, reason: 'The key is incomplete -- copy the whole thing.' }
  let payload: unknown
  try {
    payload = JSON.parse(utf8Decode(payloadBytes))
  } catch {
    return { ok: false, reason: 'The key is damaged -- copy it again.' }
  }
  if (!isLicensePayload(payload)) return { ok: false, reason: 'The key is damaged -- copy it again.' }
  return { ok: true, key: { payload, payloadBytes, signature } }
}

export function encodeLicenseKey(payloadBytes: Uint8Array, signature: Uint8Array): string {
  return `${LICENSE_KEY_PREFIX}.${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(signature)}`
}

function isLicensePayload(value: unknown): value is LicensePayload {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<LicensePayload>
  return (
    p.v === 1 &&
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    typeof p.name === 'string' &&
    (p.plan === 'trial' || p.plan === 'standard' || p.plan === 'lifetime') &&
    typeof p.issuedAt === 'string' &&
    (p.expiresAt === null || typeof p.expiresAt === 'string') &&
    (p.machineId === undefined || typeof p.machineId === 'string') &&
    (p.contact === undefined || typeof p.contact === 'string')
  )
}

// --- verdict ---------------------------------------------------------------

/** The verdict for an already signature-checked payload on this machine
 * at this moment. Pure, so the boundary cases are unit-tested. */
export function evaluateLicense(payload: LicensePayload, machineId: string, now: Date = new Date()): LicenseState {
  if (payload.machineId && normalizeMachineId(payload.machineId) !== normalizeMachineId(machineId)) {
    return { state: 'wrong-machine', payload }
  }
  if (payload.expiresAt) {
    const expires = new Date(payload.expiresAt)
    if (Number.isNaN(expires.getTime())) return { state: 'invalid', reason: 'The key has an unreadable expiry date.' }
    if (expires.getTime() <= now.getTime()) return { state: 'expired', payload, expiredAt: payload.expiresAt }
    return { state: 'valid', payload, daysLeft: Math.ceil((expires.getTime() - now.getTime()) / 86_400_000) }
  }
  return { state: 'valid', payload, daysLeft: null }
}

/** Machine ids are shown grouped (`AB12-CD34-...`) and typed back by hand,
 * so case and dashes never count. */
export function normalizeMachineId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

export function formatMachineId(hex: string): string {
  const clean = normalizeMachineId(hex).slice(0, 16)
  return clean.match(/.{1,4}/g)?.join('-') ?? clean
}

export const PLAN_LABELS: Record<LicensePlan, string> = {
  trial: 'Trial',
  standard: 'Standard',
  lifetime: 'Lifetime'
}

/** Combines the signed key's own verdict with what the server said. The
 * server may shorten a license, but must never extend a signed expiry:
 * its cached verdict is stored in user-editable license.json. Renewals
 * require a newly signed key from the Admin panel. */
export function applyServerVerdict(offline: LicenseState, server: ServerVerdict | null | undefined, now: Date = new Date()): LicenseState {
  if (!server || server.status === 'unknown') return offline
  const payload = 'payload' in offline ? offline.payload : null
  if (!payload) return offline
  switch (server.status) {
    case 'revoked':
      return { state: 'revoked', payload, message: server.message ?? 'This license was cancelled by the seller.' }
    case 'machine-mismatch':
      return { state: 'wrong-machine', payload }
    case 'expired':
      return { state: 'expired', payload, expiredAt: server.expiresAt ?? payload.expiresAt ?? server.checkedAt }
    case 'active': {
      if (offline.state !== 'valid') return offline
      const signedUntil = payload.expiresAt ? new Date(payload.expiresAt).getTime() : Infinity
      const serverUntil = server.expiresAt ? new Date(server.expiresAt).getTime() : Infinity
      if (Number.isNaN(serverUntil)) return offline
      const until = Math.min(signedUntil, serverUntil)
      if (until === Infinity) return offline
      if (until <= now.getTime()) {
        return { state: 'expired', payload, expiredAt: signedUntil <= serverUntil ? payload.expiresAt! : server.expiresAt! }
      }
      return { state: 'valid', payload, daysLeft: Math.ceil((until - now.getTime()) / 86_400_000) }
    }
    default:
      return offline
  }
}

/** A signed key only opens the editor after this session's backend check-in.
 * No response and unregistered keys fail closed, including when a previous
 * active verdict is present in the user-editable license file. */
export function requireOnlineVerdict(offline: LicenseState, server: ServerVerdict | null, now: Date = new Date()): LicenseState {
  if (offline.state !== 'valid') return offline
  if (!server) return { state: 'verification-required', reason: 'Internet and the license server are required. Check your connection and retry.' }
  if (server.status === 'unknown') return { state: 'verification-required', reason: 'This key is not registered on the license server. Ask the seller to sync it, then retry.' }
  return applyServerVerdict(offline, server, now)
}
