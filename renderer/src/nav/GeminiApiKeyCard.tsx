import { useEffect, useState } from 'react'
import { parseGeminiKeys } from '@shared/geminiKeyPool'
import { GeminiRouterOverlay } from './GeminiRouterOverlay'

type KeyCheck = { mask: string; state: 'ok' | 'refused' | 'unknown'; note: string }

export function GeminiApiKeyCard(): JSX.Element {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [checks, setChecks] = useState<KeyCheck[] | null>(null)
  const [routerOpen, setRouterOpen] = useState(false)

  const refresh = (): void => {
    void window.api.videoStoryNarration.hasApiKey().then(setHasKey)
    void window.api.videoStoryNarration.checkApiKeys().then(setChecks).catch(() => setChecks(null))
  }

  useEffect(refresh, [])

  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const count = await window.api.videoStoryNarration.setApiKey(key)
      setKey('')
      setHasKey(true)
      setMessage(`Saved securely. ${count} key${count === 1 ? '' : 's'} in the router.`)
      refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await window.api.videoStoryNarration.clearApiKey()
      const stillConfigured = await window.api.videoStoryNarration.hasApiKey()
      setHasKey(stillConfigured)
      setMessage(stillConfigured ? 'The saved keys were removed; an environment key is still active.' : 'Gemini API keys removed.')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const count = checks?.length ?? 0
  const found = parseGeminiKeys(key).length

  return (
    <div className="settings-section gemini-key-card">
      <div className="gemini-key-head">
        <span><strong>Google Gemini API</strong><small>The next key takes over when one runs out of quota or is refused.</small></span>
        <span className="gemini-key-head-side">
          {hasKey && <button className="settings-button" onClick={() => setRouterOpen(true)}>Open Router</button>}
          <span className={hasKey ? 'gemini-key-status ready' : 'gemini-key-status'}>{hasKey ? (count > 1 ? `${count} keys` : 'Configured') : 'Not configured'}</span>
        </span>
      </div>
      <p className="settings-row-hint">Paste one or many, one per line; an email beside a key is ignored. Keys are encrypted with Windows secure storage and never shown again, added to projects or written to logs.</p>
      <div className="gemini-key-form">
        <textarea className="settings-control" rows={hasKey ? 2 : 3} autoComplete="off" spellCheck={false} placeholder="Paste one key or many, one per line" value={key} onChange={(event) => setKey(event.target.value)} />
        <button className="settings-button settings-button-primary" disabled={found === 0 || busy} onClick={() => void save()}>{busy ? 'Saving…' : found > 1 ? `Add ${found} Keys` : 'Add Key'}</button>
        {hasKey && <button className="settings-button" disabled={busy} onClick={() => void clear()}>{count > 1 ? 'Remove All' : 'Remove'}</button>}
      </div>
      {key.trim() && <div className="settings-status">{found > 0 ? `${found} key${found === 1 ? '' : 's'} found` : 'No key found in this text'}</div>}
      {checks && checks.length > 0 && (
        <ul className="gemini-key-list">
          {checks.map((check) => (
            <li key={check.mask} className={`gemini-key-row ${check.state}`}>
              <code>{check.mask}</code>
              <span>{check.note}</span>
            </li>
          ))}
        </ul>
      )}
      {message && <div className="settings-status">{message}</div>}
      {routerOpen && <GeminiRouterOverlay onClose={() => setRouterOpen(false)} />}
    </div>
  )
}
