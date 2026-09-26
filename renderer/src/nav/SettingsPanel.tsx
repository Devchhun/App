import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdaterStatus } from '@shared/updater'
import type { AppTheme } from './themePrefs'
import type { SettingsCategoryId } from './settingsSections'
import { useTheme } from './ThemeContext'
import { SunIcon, MoonIcon } from './icons'
import { VoxCpmConfigPanel } from './VoxCpmConfigPanel'
import { LicenseSettingsCard } from '../license/LicenseSettingsCard'
import { TranscriptionSettingsCard } from '../transcript/TranscriptionSettingsCard'
import { DEFAULT_VOXCPM_SETTINGS, parseStoredVoxCpmSettings, serializeVoxCpmSettings, getVoxCpmSettingsStorageKey } from '../dubbing/voxcpmSettings'
import { GeminiApiKeyCard } from './GeminiApiKeyCard'

/** The Titlebar has its own compact update icon-button (see UpdateButton in
 * Titlebar.tsx) driven by the same window.api.updater surface -- this panel
 * is the discoverable, always-visible home for the same controls, so update
 * status/actions aren't only reachable via a small icon whose tooltip is the
 * only explanation of what it does. */
export function SettingsPanel({ category }: { category: SettingsCategoryId }): JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' })
  const { theme, setTheme } = useTheme()
  const [appVersion, setAppVersion] = useState<string>('')
  const [voxcpm, setVoxcpm] = useState(() => {
    if (typeof localStorage === 'undefined') return DEFAULT_VOXCPM_SETTINGS
    try {
      return parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey()))
    } catch {
      return DEFAULT_VOXCPM_SETTINGS
    }
  })

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion)
    return window.api.updater.onStatus(setStatus)
  }, [])

  // Same "one persistence effect for the whole preference set" pattern as
  // TimelineViewContext.tsx -- a per-machine preference, never part of the
  // project file. Deliberately skips its own FIRST run: this panel's state
  // is seeded from storage at mount, so writing it straight back changes
  // nothing at best, and at worst republishes a stale snapshot over a value
  // another panel has since changed -- the Voice Model panel's own engine
  // switch writes the same key, so a mount-time write here could silently
  // flip the engine back to whatever this panel last read.
  const hasHydratedRef = useRef(false)
  useEffect(() => {
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true
      return
    }
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(getVoxCpmSettingsStorageKey(), serializeVoxCpmSettings(voxcpm))
    } catch {
      // Storage unavailable/full -- the in-memory setting still works for this session.
    }
  }, [voxcpm])


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
      {category === 'appearance' && (
      <div className="settings-section">
        <h3 className="settings-section-title">Appearance</h3>
        <div className="settings-row">
          <span className="settings-row-label">Theme</span>
          <div className="theme-switch" role="group" aria-label="Theme">
            {(['dark', 'light'] as AppTheme[]).map((t) => (
              <button
                key={t}
                className={theme === t ? 'theme-switch-option theme-switch-option-active' : 'theme-switch-option'}
                onClick={() => setTheme(t)}
              >
                {t === 'dark' ? <MoonIcon size={13} /> : <SunIcon size={13} />}
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </div>
      </div>
      )}

      {(category === 'updates' || category === 'about') && (
      <div className="settings-section">
        <h3 className="settings-section-title">{category === 'about' ? 'About' : 'Updates'}</h3>
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
      )}

      {category === 'license' && <LicenseSettingsCard />}

      {category === 'transcription' && <TranscriptionSettingsCard />}

      {category === 'apiKeys' && <GeminiApiKeyCard />}

      {category === 'voice' && <VoxCpmConfigPanel settings={voxcpm} onChange={(next) => setVoxcpm((prev) => ({ ...prev, ...next }))} />}

    </div>
  )
}
