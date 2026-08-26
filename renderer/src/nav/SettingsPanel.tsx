import { useCallback, useEffect, useState } from 'react'
import type { UpdaterStatus } from '@shared/updater'

/** The Titlebar has its own compact update icon-button (see UpdateButton in
 * Titlebar.tsx) driven by the same window.api.updater surface -- this panel
 * is the discoverable, always-visible home for the same controls, so update
 * status/actions aren't only reachable via a small icon whose tooltip is the
 * only explanation of what it does. */
export function SettingsPanel(): JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' })
  const [appVersion, setAppVersion] = useState<string>('')

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion)
    return window.api.updater.onStatus(setStatus)
  }, [])

  const busy = status.state === 'checking' || status.state === 'downloading'

  const handleCheck = useCallback(() => {
    if (busy) return
    void window.api.updater.check()
  }, [busy])

  const handleInstall = useCallback(() => {
    void window.api.updater.quitAndInstall()
  }, [])

  const statusLine = ((): string => {
    switch (status.state) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `Update ${status.version} found — downloading…`
      case 'downloading':
        return `Downloading update… ${status.percent}%`
      case 'downloaded':
        return `Update ${status.version} is ready to install.`
      case 'not-available':
        return "You're up to date."
      case 'error':
        return `Update check failed: ${status.message}`
      case 'unsupported':
        return 'Auto-update only runs in the installed app, not in dev mode.'
      default:
        return 'No check has run yet this session.'
    }
  })()

  return (
    <div className="settings-panel editor-scroll">
      <div className="settings-section">
        <h3 className="settings-section-title">Updates</h3>
        <div className="settings-row">
          <span className="settings-row-label">Current version</span>
          <span className="settings-row-value">{appVersion || '…'}</span>
        </div>
        <div className={status.state === 'error' ? 'settings-status settings-status-error' : 'settings-status'}>{statusLine}</div>
        <div className="settings-actions">
          {status.state === 'downloaded' ? (
            <button className="settings-button settings-button-primary" onClick={handleInstall}>
              Restart & Install
            </button>
          ) : (
            <button className="settings-button" onClick={handleCheck} disabled={busy || status.state === 'unsupported'}>
              Check for Updates
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
