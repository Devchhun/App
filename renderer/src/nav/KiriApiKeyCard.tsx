import { useEffect, useState } from 'react'

/** Settings > AI API Keys: the KiriTTS key (the AI Dubber's cloud engine).
 * Same handling as the Gemini key -- encrypted on this machine, never shown
 * again. "Check" lists the account's voices to prove the key works; speech
 * itself also needs a KiriTTS plan with API access (Starter or above). */
export function KiriApiKeyCard(): JSX.Element {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = (): void => {
    void window.api.kiri.hasKey().then(setHasKey)
  }

  useEffect(refresh, [])

  const check = async (): Promise<void> => {
    const result = await window.api.kiri.listVoices()
    setMessage(
      result.ok
        ? `Key works: ${result.voices.length} voices (${result.voices.filter((v) => v.cloned).length} cloned). Speaking needs a KiriTTS plan with API access (Starter or above).`
        : result.error
    )
  }

  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setMessage(null)
    try {
      await window.api.kiri.setKey(key)
      setKey('')
      setHasKey(true)
      await check()
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
      await window.api.kiri.clearKey()
      const stillConfigured = await window.api.kiri.hasKey()
      setHasKey(stillConfigured)
      setMessage(stillConfigured ? 'The saved key was removed; an environment key is still active.' : 'KiriTTS API key removed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section gemini-key-card">
      <div className="gemini-key-head">
        <span>
          <strong>KiriTTS API</strong>
          <small>AI Dubber's cloud voices and voice cloning (kiritts.com)</small>
        </span>
        <span className={hasKey ? 'gemini-key-status ready' : 'gemini-key-status'}>{hasKey ? 'Configured' : 'Not configured'}</span>
      </div>
      <p className="settings-row-hint">The key is encrypted with Windows secure storage. It is never returned to the UI, included in projects, or written to logs.</p>
      <div className="gemini-key-form">
        <input
          className="settings-control"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? 'Enter a new key to replace it' : 'Paste KiriTTS API key (sk-…)'}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
        />
        <button className="settings-button settings-button-primary" disabled={!key.trim() || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : hasKey ? 'Replace Key' : 'Save Key'}
        </button>
        {hasKey && (
          <button className="settings-button" disabled={busy} onClick={() => void check()}>
            Check
          </button>
        )}
        {hasKey && (
          <button className="settings-button" disabled={busy} onClick={() => void clear()}>
            Remove
          </button>
        )}
      </div>
      {message && <div className="settings-status">{message}</div>}
    </div>
  )
}
