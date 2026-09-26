import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LicenseStatus } from '@shared/license'

interface LicenseContextValue {
  /** null until the first status read comes back -- the gate shows nothing
   * (not the activation screen) for that instant, so a licensed user never
   * sees "Enter your key" flash on launch. */
  status: LicenseStatus | null
  refresh: () => Promise<void>
  activate: (key: string) => Promise<{ ok: true } | { ok: false; error: string }>
  deactivate: () => Promise<void>
}

const LicenseContext = createContext<LicenseContextValue | null>(null)

/** The app's license state, read once from the main process and re-read
 * after every activate/deactivate. Verification itself lives in the main
 * process (app/main/license/licenseStore.ts) -- the renderer only ever sees
 * the verdict. */
export function LicenseProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<LicenseStatus | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.api.license.getStatus())
    } catch (err) {
      // A missing/stale preload must fail closed and show the activation
      // screen with an explanation, rather than mounting the editor.
      setStatus({ license: { state: 'invalid', reason: err instanceof Error ? err.message : String(err) }, machineId: '', appVersion: '' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    // A background check-in (revocation, renewal on the server) re-renders
    // the gate without a restart.
    try {
      return window.api.license.onStatusChanged(setStatus)
    } catch {
      return undefined
    }
  }, [refresh])

  const activate = useCallback(async (key: string) => {
    const result = await window.api.license.activate(key)
    setStatus(result.status)
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error }
  }, [])

  const deactivate = useCallback(async () => {
    setStatus(await window.api.license.deactivate())
  }, [])

  const value = useMemo(() => ({ status, refresh, activate, deactivate }), [status, refresh, activate, deactivate])
  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>
}

export function useLicense(): LicenseContextValue {
  const ctx = useContext(LicenseContext)
  if (!ctx) throw new Error('useLicense must be used within LicenseProvider')
  return ctx
}
