import type { CloudRequestPreview } from '@shared/suggestions'

interface Props {
  preview: CloudRequestPreview
  onCancel: () => void
  onConfirm: () => void
}

export function CloudConsentModal({ preview, onCancel, onConfirm }: Props): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Send transcript text to Claude?</h2>
          <button className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <p className="consent-text">
          This will send <strong>{preview.segmentCount}</strong> transcript segment(s) ({preview.characterCount} characters)
          to Anthropic's <strong>{preview.model}</strong> API for classification. <strong>No video or audio is ever sent</strong> —
          only the text below.
        </p>
        <div className="consent-preview" lang="km">
          {preview.textPreview}
          {preview.characterCount > preview.textPreview.length ? '…' : ''}
        </div>
        <div className="consent-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="consent-confirm" onClick={onConfirm}>
            Send &amp; Generate Suggestions
          </button>
        </div>
      </div>
    </div>
  )
}
