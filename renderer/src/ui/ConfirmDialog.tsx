import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/** In-app replacement for `window.confirm`. The native dialog is drawn by
 * Windows itself -- OS chrome, OS fonts, a "creative-ai-editor" title bar --
 * so it looked nothing like the rest of the app no matter how the app is
 * styled. This keeps the same one-line, promise-returning ergonomics
 * (`if (await confirm({...}))`) so call sites don't have to be rewritten
 * into open/pending/result state machines. */
export interface ConfirmOptions {
  title: string
  /** Body copy. Lines are rendered as separate paragraphs. */
  message: string | string[]
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button, for anything that deletes or discards. */
  danger?: boolean
  /** Alert-style: one dismiss button, no Cancel, because there's nothing to
   * decide -- the message is just reporting what happened. */
  hideCancel?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const confirm = useCallback<ConfirmFn>((options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })), [])

  const settle = (confirmed: boolean): void => {
    if (!pending) return
    pending.resolve(confirmed)
    setPending(null)
  }

  const value = useMemo(() => confirm, [confirm])
  const lines = pending ? (Array.isArray(pending.message) ? pending.message : [pending.message]) : []

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div className="modal-overlay" onClick={() => settle(false)}>
          <div className="modal-panel confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{pending.title}</h2>
              <button className="modal-close" onClick={() => settle(false)}>
                ×
              </button>
            </div>
            <div className="confirm-dialog-body">
              {lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
            <div className="confirm-dialog-actions">
              {!pending.hideCancel && (
                <button className="confirm-dialog-cancel" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? 'Cancel'}
                </button>
              )}
              <button
                className={pending.danger ? 'confirm-dialog-confirm confirm-dialog-confirm-danger' : 'confirm-dialog-confirm'}
                autoFocus
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmDialogProvider')
  return ctx
}
