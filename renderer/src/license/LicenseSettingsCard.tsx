import { useState } from 'react'
import { useLicense } from './LicenseContext'
import { PLAN_LABELS } from '@shared/license'

/** Settings > License: who this copy is licensed to, until when, this
 * machine's id (for renewals), a place to paste a newer key, and Deactivate
 * for moving to another computer. */
export function LicenseSettingsCard(): JSX.Element {
  const { status, activate, deactivate } = useLicense()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  if (!status) return <div className="settings-status">Reading license…</div>

  const license = status.license
  const payload = 'payload' in license ? license.payload : null

  const apply = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setNote(null)
    try {
      const result = await activate(key)
      setNote(result.ok ? { kind: 'ok', text: 'Key accepted -- this computer is activated.' } : { kind: 'error', text: result.error })
      if (result.ok) setKey('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">License</h3>

      <div className="settings-row">
        <span className="settings-row-label">Status</span>
        <span className={`settings-row-value license-status-${license.state}`}>
          {license.state === 'valid'
            ? license.daysLeft === null
              ? 'Active'
              : `Active -- ${license.daysLeft} day${license.daysLeft === 1 ? '' : 's'} left`
            : license.state === 'expired'
              ? 'Expired'
              : license.state === 'revoked'
                ? 'Cancelled by the seller'
                : license.state === 'wrong-machine'
                  ? 'Issued for another computer'
                : license.state === 'invalid'
                  ? 'Not accepted'
                  : license.state === 'verification-required'
                    ? 'Online verification required'
                  : 'Not activated'}
        </span>
      </div>
      {payload && (
        <>
          <div className="settings-row">
            <span className="settings-row-label">Licensed to</span>
            <span className="settings-row-value">{payload.name}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Plan</span>
            <span className="settings-row-value">{PLAN_LABELS[payload.plan]}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Expires</span>
            <span className="settings-row-value">{payload.expiresAt ? payload.expiresAt.slice(0, 10) : 'Never'}</span>
          </div>
        </>
      )}
      {status.serverCheckedAt && (
        <div className="settings-row">
          <span className="settings-row-label">Last verified with server</span>
          <span className="settings-row-value">{status.serverCheckedAt.slice(0, 16).replace('T', ' ')}</span>
        </div>
      )}
      <div className="settings-row">
        <span className="settings-row-label">Machine ID</span>
        <code className="settings-row-value license-settings-machine">{status.machineId}</code>
      </div>

      <label className="license-field license-field-compact">
        <span>Enter a new key</span>
        <textarea className="license-key-input" rows={2} placeholder="CAE1.…" value={key} spellCheck={false} onChange={(e) => setKey(e.target.value)} />
      </label>
      {note && <div className={note.kind === 'ok' ? 'settings-status' : 'settings-status settings-status-error'}>{note.text}</div>}
      <div className="settings-actions">
        <button className="settings-button settings-button-primary" disabled={busy || !key.trim()} onClick={() => void apply()}>
          {busy ? 'Checking…' : 'Apply key'}
        </button>
        {license.state !== 'none' && (
          <button
            className="settings-button"
            disabled={busy}
            title="Remove the key from this computer (to use it on another one). The app will ask for a key again."
            onClick={() => void deactivate()}
          >
            Deactivate
          </button>
        )}
      </div>
    </div>
  )
}
