import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useAiSuggestions } from './AiSuggestionsContext'
import { useUiState } from '../nav/UiStateContext'
import { PURPOSE_LABELS } from '@shared/suggestions'
import { formatDuration } from '../media/format'

const PREVIEW_COUNT = 3

/** Compact companion to the full AI Suggestions panel (right sidebar) --
 * quick-glance list + one-click accept, matching the reference layout's
 * left-column AI Suggestions column. Full edit/lock/filter/regenerate stays
 * in the right sidebar to avoid duplicating that state machine here. */
export function AiSuggestionsPreviewList(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { suggestionsByMedia, setSuggestionStatus } = useAiSuggestions()
  const { setRightTab } = useUiState()
  const { seekTo } = usePlayback()

  const media = items.find((m) => m.id === selectedId)
  const suggestions = media ? (suggestionsByMedia[media.id] ?? []) : []
  const preview = suggestions.slice(0, PREVIEW_COUNT)

  if (suggestions.length === 0) {
    return <p className="placeholder">No suggestions yet.</p>
  }

  return (
    <div className="ai-preview-list editor-scroll">
      {preview.map((s) => (
        <div key={s.id} className="ai-preview-card" onClick={() => seekTo(s.startTime)}>
          <span className="ai-preview-purpose-badge">{PURPOSE_LABELS[s.purpose][0]}</span>
          <div className="ai-preview-body">
            <div className="ai-preview-title">{PURPOSE_LABELS[s.purpose]}</div>
            <div className="ai-preview-text" lang="km">
              {s.visualText}
            </div>
            <div className="ai-preview-time">
              {formatDuration(s.startTime)} – {formatDuration(s.endTime)}
            </div>
          </div>
          {s.status === 'suggested' && (
            <button
              className="ai-preview-add"
              title="Accept"
              onClick={(e) => {
                e.stopPropagation()
                if (media) setSuggestionStatus(media.id, s.id, 'accepted')
              }}
            >
              +
            </button>
          )}
        </div>
      ))}
      <button className="inline-link-button" onClick={() => setRightTab('ai')}>
        View all suggestions ({suggestions.length})
      </button>
    </div>
  )
}
