import type { MediaItem } from '@shared/media'
import { formatDuration } from './format'

interface Props {
  item: MediaItem
  selected: boolean
  /** Part of the current multi-selection (see MediaContext.selectedIds) --
   * an entirely separate visual state from `selected` (the single asset
   * open for inspection/Preview source). */
  multiSelected?: boolean
  compact?: boolean
  onSelect: (e: React.MouseEvent) => void
  onCancel: () => void
  onRetry: () => void
  /** Undefined while the asset isn't ready to place (still validating/probing). */
  onAddToTimeline?: () => void
  /** Undefined while the asset isn't ready to drag onto the Timeline. */
  onDragStart?: (e: React.DragEvent) => void
}

const TERMINAL_STAGES = new Set(['ready', 'error', 'canceled'])

export function MediaListItem({ item, selected, multiSelected = false, compact = false, onSelect, onCancel, onRetry, onAddToTimeline, onDragStart }: Props): JSX.Element {
  const stillWorking = !TERMINAL_STAGES.has(item.stage)
  // `readyToUse` (set once probing knows duration/hasAudio and has a
  // playable original URL) is a separate, earlier gate than `stage ===
  // 'ready'` (every background job finished) -- see shared/media.ts's doc
  // comment. An item can be fully usable on the Timeline while its
  // thumbnail/waveform/proxy are still cooking, or even after one of them
  // fails, so the big blocking "still importing" treatment only applies
  // before that point; everything after it is a small, non-blocking badge.
  const blockedOnImport = !item.readyToUse && stillWorking
  const backgroundBusy = item.readyToUse && stillWorking
  const backgroundFailed = item.readyToUse && item.stage === 'error'
  const backgroundCanceled = item.readyToUse && item.stage === 'canceled'
  const showCancel = blockedOnImport || backgroundBusy
  const showRetry = (!item.readyToUse && (item.stage === 'error' || item.stage === 'canceled')) || backgroundFailed || backgroundCanceled

  const addButton = onAddToTimeline && (
    <button
      className="media-thumb-add-button"
      title="Add to Timeline"
      onClick={(e) => {
        e.stopPropagation()
        onAddToTimeline()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      +
    </button>
  )

  const actions = (showCancel || showRetry) && (
    <div className="media-card-actions">
      {showCancel && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onCancel()
          }}
        >
          Cancel
        </button>
      )}
      {showRetry && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRetry()
          }}
        >
          Retry
        </button>
      )}
    </div>
  )

  // Small pill shown in a thumbnail corner once the asset is already usable
  // but a background job (thumbnail/waveform/proxy) is still running,
  // failed, or was canceled -- never dims or covers the thumbnail itself.
  const backgroundBadge = (backgroundBusy || backgroundFailed || backgroundCanceled) && (
    <span className={`media-thumb-bg-badge${backgroundFailed ? ' media-thumb-bg-badge-warning' : ''}`}>
      {backgroundBusy && `${Math.round(item.percent)}%`}
      {backgroundFailed && '⚠ proxy failed'}
      {backgroundCanceled && 'canceled'}
    </span>
  )

  if (compact) {
    return (
      <li
        className={`media-row${selected ? ' media-row-selected' : ''}${multiSelected ? ' media-row-multi-selected' : ''}`}
        draggable={!!onDragStart}
        onDragStart={onDragStart}
        onClick={onSelect}
        onDoubleClick={() => onAddToTimeline?.()}
        title={onAddToTimeline ? 'Double-click to add to Timeline · drag onto the Timeline to place' : undefined}
      >
        <div className="media-row-thumb">
          {item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt="" />
          ) : (
            <div className="media-thumb-placeholder">{item.kind === 'audio' ? '♪' : '▶'}</div>
          )}
          {addButton}
          {backgroundBadge}
        </div>
        <div className="media-row-info">
          <div className="media-row-name">{item.fileName || 'Importing…'}</div>
          {!item.readyToUse && item.stage === 'error' && <div className="media-error">{item.errorMessage}</div>}
          {!item.readyToUse && item.stage === 'canceled' && <div className="media-error">Canceled</div>}
          {blockedOnImport && (
            <div className="media-progress-track media-row-progress-track">
              <div className="media-progress-bar" style={{ width: `${Math.round(item.percent)}%` }} />
            </div>
          )}
        </div>
        {item.metadata && <span className="media-row-duration">{formatDuration(item.metadata.durationSeconds)}</span>}
        {selected && <span className="media-card-check media-row-check">✓</span>}
        {actions}
      </li>
    )
  }

  return (
    <li
      className={`media-card${selected ? ' media-card-selected' : ''}${multiSelected ? ' media-card-multi-selected' : ''}`}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={onSelect}
      onDoubleClick={() => onAddToTimeline?.()}
      title={onAddToTimeline ? 'Double-click to add to Timeline · drag onto the Timeline to place' : undefined}
    >
      <div className="media-card-thumb">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" />
        ) : (
          <div className="media-thumb-placeholder">{item.kind === 'audio' ? '♪' : '▶'}</div>
        )}
        {selected && <span className="media-card-check">✓</span>}
        {item.metadata && <span className="media-card-duration">{formatDuration(item.metadata.durationSeconds)}</span>}
        {addButton}
        {backgroundBadge}
        {blockedOnImport && (
          <div className="media-card-progress-overlay">
            <div className="media-progress-track">
              <div className="media-progress-bar" style={{ width: `${Math.round(item.percent)}%` }} />
            </div>
            <span className="media-progress-label">
              {item.stage} · {Math.round(item.percent)}%
            </span>
          </div>
        )}
      </div>
      <div className="media-card-name">{item.fileName || 'Importing…'}</div>
      {!item.readyToUse && item.stage === 'error' && <div className="media-error">{item.errorMessage}</div>}
      {!item.readyToUse && item.stage === 'canceled' && <div className="media-error">Canceled</div>}
      {backgroundFailed && <div className="media-error">Background processing failed -- using original file. {item.errorMessage}</div>}
      {actions}
    </li>
  )
}
