import type { CloudRequestPreview } from '@shared/suggestions'

interface Props {
  preview: CloudRequestPreview
  onCancel: () => void
  onConfirm: () => void
  /** What the text is sent for, e.g. "translation". Defaults to AI
   * Suggestions' own "classification". */
  purpose?: string
  confirmLabel?: string
}

/** Who actually receives the text -- read from the model the main process
 * picked, so the dialog can never name one company while the text goes to
 * another (translation uses Gemini when its key is saved). */
export function cloudServiceFor(model: string): { short: string; company: string } {
  return /^gemini/i.test(model) ? { short: 'Gemini', company: 'Google' } : { short: 'Claude', company: 'Anthropic' }
}

export function CloudConsentModal({ preview, onCancel, onConfirm, purpose = 'classification', confirmLabel = 'Send & Generate Suggestions' }: Props): JSX.Element {
  const service = cloudServiceFor(preview.model)
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Send transcript text to {service.short}?</h2>
          <button className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <p className="consent-text">
          This will send <strong>{preview.segmentCount}</strong> transcript segment(s) ({preview.characterCount} characters)
          to {service.company}'s <strong>{preview.model}</strong> API for {purpose}. <strong>No video or audio is ever sent</strong> —
          only the text below.
        </p>
        <div className="consent-preview" lang="km">
          {preview.textPreview}
          {preview.characterCount > preview.textPreview.length ? '…' : ''}
        </div>
        <div className="consent-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="consent-confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
