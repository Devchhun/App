import { useEffect, useState, type ReactNode } from 'react'
import { useLicense } from './LicenseContext'
import { PLAN_LABELS, type LicenseState } from '@shared/license'

/** What to tell the user, by how they get in. The registration flow needs
 * nothing from them at all -- their computer has already asked. */
const CONTACT_LINE = 'Send your Machine ID to the seller to receive a key.'
const WAITING_LINE = 'Your request has been sent. Keep this window open -- the editor opens by itself once the seller approves this computer.'

/** Everything behind this is the editor; in front of it, until a valid key
 * is on this machine, is only the activation screen. The Machine ID is the
 * one thing the user needs to send off, so it's the biggest, most copyable
 * thing on the page. */
export function LicenseGate({ children }: { children: ReactNode }): JSX.Element {
  const { status, refresh } = useLicense()
  const waiting = status?.license.state === 'pending-approval'

  // While this computer is waiting for the seller, ask again every few
  // seconds: approval then opens the editor by itself, with nothing to
  // paste and no restart (the main process also pushes a status event --
  // this is the belt to that braces).
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void refresh(), 8000)
    return () => clearInterval(timer)
  }, [waiting, refresh])

  if (!status) return <div className="license-gate"><GateControls /><p className="license-lead">Checking license with the server...</p></div>
  if (status.license.state === 'valid' || status.license.state === 'device-approved') return <>{children}</>
  return <ActivationScreen state={status.license} machineId={status.machineId} appVersion={status.appVersion} />
}

function GateControls(): JSX.Element {
  return (
    <div className="license-gate-controls">
      <button className="window-control-button" aria-label="Minimize" title="Minimize" onClick={() => void window.api.windowControls.minimize()}>−</button>
      <button className="window-control-button window-control-close" aria-label="Close" title="Close" onClick={() => void window.api.windowControls.close()}>×</button>
    </div>
  )
}

function describe(state: LicenseState): { title: string; detail: string } | null {
  switch (state.state) {
    case 'none':
      return null
    case 'pending-approval':
      return { title: 'Waiting for approval', detail: 'This computer has been registered with the seller. Access opens here by itself as soon as they approve it -- no key to type in.' }
    case 'blocked':
      return { title: 'Access turned off', detail: state.message }
    case 'device-expired':
      return {
        title: 'Your time has run out',
        detail: state.expiredAt ? `Access for this computer ended on ${state.expiredAt.slice(0, 10)}. Ask the seller for more days.` : 'Ask the seller for more days.'
      }
    case 'invalid':
      return { title: 'Key not accepted', detail: state.reason }
    case 'verification-required':
      return { title: 'Online verification required', detail: state.reason }
    case 'expired':
      return { title: 'License expired', detail: `Your ${PLAN_LABELS[state.payload.plan]} key for ${state.payload.name} expired on ${state.expiredAt.slice(0, 10)}. Ask for a renewed key.` }
    case 'wrong-machine':
      return { title: 'Key is for another computer', detail: `This key was issued to ${state.payload.name} for a different Machine ID.` }
    case 'revoked':
      return { title: 'License cancelled', detail: `${state.message} (${state.payload.name})` }
    default:
      return null
  }
}

function ActivationScreen({ state, machineId, appVersion }: { state: LicenseState; machineId: string; appVersion: string }): JSX.Element {
  const { activate, refresh } = useLicense()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const problem = describe(state)
  // The registration flow ("the seller grants days to this computer") is
  // what a normal user sees; the key box is the fallback for anyone who
  // was given a key file, so it stays, folded away.
  const waiting = state.state === 'pending-approval'
  const deviceFlow = waiting || state.state === 'blocked' || state.state === 'device-expired'
  const [keyOpen, setKeyOpen] = useState(!deviceFlow)

  const submit = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await activate(key)
      if (!result.ok) setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  const copyMachineId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(machineId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked -- the id is still selectable text.
    }
  }

  const retry = async (): Promise<void> => {
    if (retrying) return
    setRetrying(true)
    setError(null)
    try {
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="license-gate">
      <GateControls />
      <div className="license-card">
        <div className="license-brand">
          <span className="license-brand-mark">✦</span>
          <span className="license-brand-name">Creative AI Editor</span>
          {appVersion && <span className="license-brand-version">v{appVersion}</span>}
        </div>

        <h1 className="license-title">{waiting ? 'Waiting for approval' : deviceFlow ? 'This computer needs access' : 'Activate this computer'}</h1>
        <p className="license-lead">{deviceFlow ? WAITING_LINE : CONTACT_LINE}</p>

        <div className="license-machine">
          <span className="license-machine-label">Your Machine ID</span>
          <code className="license-machine-id">{machineId || '…'}</code>
          <button className="license-copy" onClick={() => void copyMachineId()} disabled={!machineId}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>

        {problem && (
          <div className={waiting ? 'license-problem license-problem-info' : 'license-problem'}>
            <strong>{problem.title}</strong>
            <span>{problem.detail}</span>
          </div>
        )}

        {waiting && (
          <div className="license-waiting">
            <span className="license-waiting-dot" aria-hidden />
            Checking with the seller every few seconds…
          </div>
        )}

        {(state.state === 'verification-required' || deviceFlow) && (
          <button className="license-activate" disabled={retrying} onClick={() => void retry()}>
            {retrying ? 'Checking server...' : 'Check again now'}
          </button>
        )}

        {deviceFlow && !keyOpen && (
          <button className="license-key-toggle" onClick={() => setKeyOpen(true)}>
            I was given a license key
          </button>
        )}

        {keyOpen && (
        <label className="license-field">
          <span>License key</span>
          <textarea
            className="license-key-input"
            rows={3}
            placeholder="CAE1.…"
            value={key}
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </label>
        )}
        {error && <div className="license-error">{error}</div>}

        {keyOpen && (
          <button className="license-activate" disabled={busy || !key.trim()} onClick={() => void submit()}>
            {busy ? 'Checking…' : 'Activate'}
          </button>
        )}
      </div>
    </div>
  )
}
