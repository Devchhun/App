import { app } from 'electron'
import { hostname, userInfo } from 'os'
import { DEVICE_REGISTER_INTERVAL_MS } from '@shared/licenseServer'
import type { DeviceVerdict } from '@shared/license'

/** "Ask the seller for days" access: the editor announces this computer to
 * the license server on launch (and every minute while it runs), and the
 * server answers with what the admin has granted it -- pending, active
 * with N days left, expired, or blocked. Nothing is issued to the user to
 * paste in: the Machine ID travelling up IS the request, and the admin
 * turns it on from the Admin panel.
 *
 * Deliberately memory-only, like the signed-key session approval next to
 * it: every launch has to reach the server, so revoking a computer takes
 * effect at its next launch (and, while it is open, within a minute). */

let lastVerdict: DeviceVerdict | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function getCachedDeviceVerdict(): DeviceVerdict | null {
  return lastVerdict
}

export function clearDeviceVerdict(): void {
  lastVerdict = null
}

/** One registration round-trip. Null = the server could not be reached,
 * which must never be treated as approval. */
export async function registerDevice(
  baseUrl: string,
  machineId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000
): Promise<DeviceVerdict | null> {
  if (!baseUrl) return null
  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl}/api/device/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineId,
        appVersion: app.getVersion(),
        hostname: safeName(() => hostname()),
        userName: safeName(() => userInfo().username),
        label: safeName(() => `${userInfo().username}@${hostname()}`)
      }),
      signal: controller.signal
    })
    if (!res.ok) return null
    const json = (await res.json()) as Partial<DeviceVerdict>
    if (!json || typeof json.status !== 'string') return null
    if (!['pending', 'active', 'expired', 'blocked'].includes(json.status)) return null
    const verdict: DeviceVerdict = {
      status: json.status as DeviceVerdict['status'],
      expiresAt: json.expiresAt ?? null,
      daysLeft: typeof json.daysLeft === 'number' ? json.daysLeft : null,
      message: json.message,
      checkedAt: json.checkedAt ?? new Date().toISOString()
    }
    lastVerdict = verdict
    return verdict
  } catch {
    return null
  } finally {
    clearTimeout(timerId)
  }
}

/** Keeps re-registering while the app runs: it is how "online" stays true
 * in the Admin panel, how a pending computer notices it was approved
 * without restarting, and how a blocked one locks within the minute.
 * `onVerdict` fires only when the verdict actually changes. */
export function startDeviceHeartbeat(baseUrl: string, machineId: string, onVerdict: (verdict: DeviceVerdict | null) => void): void {
  stopDeviceHeartbeat()
  if (!baseUrl) return
  let last = ''
  timer = setInterval(() => {
    void registerDevice(baseUrl, machineId).then((verdict) => {
      const key = verdict ? `${verdict.status}|${verdict.expiresAt ?? ''}` : ''
      if (key === last) return
      last = key
      onVerdict(verdict)
    })
  }, DEVICE_REGISTER_INTERVAL_MS)
}

export function stopDeviceHeartbeat(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function safeName(read: () => string): string {
  try {
    return read().slice(0, 60)
  } catch {
    return ''
  }
}
