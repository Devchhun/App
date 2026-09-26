import { useEffect, useState } from 'react'

export function GeminiApiKeyCard(): JSX.Element {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = (): void => {
    void window.api.videoStoryNarration.hasApiKey().then(setHasKey)
  }

  useEffect(refresh, [])

  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setMessage(null)
    try {
      await window.api.videoStoryNarration.setApiKey(key)
      setKey('')
      setHasKey(true)
      setMessage('Gemini API key saved securely.')
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
      setMessage(stillConfigured ? 'The saved key was removed; an environment key is still active.' : 'Gemini API key removed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section gemini-key-card">
      <div className="gemini-key-head">
        <span><strong>Google Gemini API</strong><small>Used by AI Video Story Narration</small></span>
        <span className={hasKey ? 'gemini-key-status ready' : 'gemini-key-status'}>{hasKey ? 'Configured' : 'Not configured'}</span>
      </div>
      <p className="settings-row-hint">The key is encrypted with Windows secure storage. It is never returned to the UI, included in projects, or written to logs.</p>
      <div className="gemini-key-form">
        <input className="settings-control" type="password" autoComplete="off" spellCheck={false} placeholder={hasKey ? 'Enter a new key to replace it' : 'Paste Gemini API key'} value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void save() }} />
        <button className="settings-button settings-button-primary" disabled={!key.trim() || busy} onClick={() => void save()}>{busy ? 'Saving…' : hasKey ? 'Replace Key' : 'Save Key'}</button>
        {hasKey && <button className="settings-button" disabled={busy} onClick={() => void clear()}>Remove</button>}
      </div>
      {message && <div className="settings-status">{message}</div>}
    </div>
  )
}
