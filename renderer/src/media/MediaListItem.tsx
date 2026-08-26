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
  /** Undefined while the asset isn't ready to place (still importing/errored). */
  onAddToTimeline?: () => void
  /** Undefined while the asset isn't ready to drag onto the Timeline. */
  onDragStart?: (e: React.DragEvent) => void
}

const TERMINAL_STAGES = new Set(['ready', 'error', 'canceled'])

export function MediaListItem({ item, selected, multiSelected = false, compact = false, onSelect, onCancel, onRetry, onAddToTimeline, onDragStart }: Props): JSX.Element {
  const isProcessing = !TERMINAL_STAGES.has(item.stage)

  const addButton = onAddToTimeline && (
    <button
      className="media-thumb-add-button"
      title="Add to Timeline"
      onClick={(e) => {
        e.stopPropagation()
        onAddToTimeline()
      }}
    >
      +
    </button>
  )

  const actions = (isProcessing || item.stage === 'error' || item.stage === 'canceled') && (
    <div className="media-card-actions">
      {isProcessing && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onCancel()
          }}
        >
          Cancel
        </button>
      )}
      {(item.stage === 'error' || item.stage === 'canceled') && (
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
        </div>
        <div className="media-row-info">
          <div className="media-row-name">{item.fileName || 'Importing…'}</div>
          {item.stage === 'error' && <div className="media-error">{item.errorMessage}</div>}
          {item.stage === 'canceled' && <div className="media-error">Canceled</div>}
          {isProcessing && (
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
        {isProcessing && (
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
      {item.stage === 'error' && <div className="media-error">{item.errorMessage}</div>}
      {item.stage === 'canceled' && <div className="media-error">Canceled</div>}
      {actions}
    </li>
  )
}
