import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useAiSuggestions } from './AiSuggestionsContext'
import { CloudConsentModal } from './CloudConsentModal'
import { PURPOSE_LABELS, PURPOSE_VALUES } from '@shared/suggestions'
import type { CloudRequestPreview, CommunicationPurpose, SuggestionStatus } from '@shared/suggestions'

const NEEDS_REVIEW_THRESHOLD = 0.6

interface Filters {
  search: string
  purposes: Set<CommunicationPurpose>
  statuses: Set<SuggestionStatus>
  lockedOnly: boolean
  needsReviewOnly: boolean
  minConfidence: number
}

const DEFAULT_FILTERS: Filters = {
  search: '',
  purposes: new Set(),
  statuses: new Set(),
  lockedOnly: false,
  needsReviewOnly: false,
  minConfidence: 0
}

export function AiSuggestionsPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { transcripts } = useTranscript()
  const { seekTo } = usePlayback()
  const {
    hasApiKey,
    saveApiKey,
    clearApiKey,
    suggestionsByMedia,
    generationState,
    lastError,
    lastResultFromCache,
    previewCloudRequest,
    generate,
    cancel,
    retry,
    regenerateOne,
    simplify,
    updateSuggestionText,
    setSuggestionStatus,
    toggleLock,
    deleteSuggestion,
    undoDelete,
    canUndoDelete
  } = useAiSuggestions()

  const [keyInput, setKeyInput] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [pendingPreview, setPendingPreview] = useState<CloudRequestPreview | null>(null)
  const [pendingForce, setPendingForce] = useState(false)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)

  const media = items.find((m) => m.id === selectedId)
  const transcript = media ? transcripts[media.id] : undefined
  const allSuggestions = media ? (suggestionsByMedia[media.id] ?? []) : []

  const filtered = useMemo(() => {
    return allSuggestions.filter((s) => {
      if (filters.search) {
        const term = filters.search.toLowerCase()
        const haystack = `${s.visualText} ${s.originalText} ${s.reason}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (filters.purposes.size > 0 && !filters.purposes.has(s.purpose)) return false
      if (filters.statuses.size > 0 && !filters.statuses.has(s.status)) return false
      if (filters.lockedOnly && !s.locked) return false
      if (filters.needsReviewOnly && s.confidence >= NEEDS_REVIEW_THRESHOLD) return false
      if (s.confidence < filters.minConfidence) return false
      return true
    })
  }, [allSuggestions, filters])

  if (!media) {
    return <div className="placeholder">Select a media item to generate AI suggestions.</div>
  }

  if (!hasApiKey) {
    return (
      <div className="ai-suggestions-panel">
        <p className="placeholder">
          Add an Anthropic API key to enable AI suggestions. The key is stored encrypted on this machine only; nothing is sent
          anywhere until you explicitly generate suggestions.
        </p>
        <div className="ai-key-form">
          <input type="password" placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
          <button onClick={() => void saveApiKey(keyInput).then(() => setKeyInput(''))} disabled={!keyInput.trim()}>
            Save Key
          </button>
        </div>
      </div>
    )
  }

  const isGenerating = generationState === 'generating'

  const handleGenerateClick = async (force: boolean): Promise<void> => {
    if (!transcript || transcript.segments.length === 0) return
    const preview = await previewCloudRequest(transcript.segments)
    setPendingPreview(preview)
    setPendingForce(force)
  }

  const handleConfirm = (): void => {
    if (!transcript) return
    setPendingPreview(null)
    void generate(media.id, transcript.segments, pendingForce)
  }

  const handleRetry = (): void => {
    if (!transcript) return
    void retry(media.id, transcript.segments)
  }

  const togglePurposeFilter = (p: CommunicationPurpose): void => {
    setFilters((prev) => {
      const next = new Set(prev.purposes)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return { ...prev, purposes: next }
    })
  }

  const toggleStatusFilter = (status: SuggestionStatus): void => {
    setFilters((prev) => {
      const next = new Set(prev.statuses)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return { ...prev, statuses: next }
    })
  }

  return (
    <div className="ai-suggestions-panel">
      <div className="panel-fixed-head">
      <div className="ai-suggestions-toolbar">
        {!isGenerating && (
          <button onClick={() => void handleGenerateClick(false)} disabled={!transcript}>
            Generate AI Suggestions
          </button>
        )}
        {isGenerating && (
          <button className="ai-cancel-button" onClick={cancel}>
            Cancel
          </button>
        )}
        {!isGenerating && allSuggestions.length > 0 && (
          <button className="inline-link-button" onClick={() => void handleGenerateClick(true)}>
            Regenerate anyway (bypass cache)
          </button>
        )}
        {!replacingKey && (
          <button className="inline-link-button" onClick={() => setReplacingKey(true)}>
            Replace key
          </button>
        )}
        <button className="inline-link-button" onClick={() => void clearApiKey()}>
          Remove API key
        </button>
      </div>

      {replacingKey && (
        <div className="ai-key-form">
          <input type="password" placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
          <button
            onClick={() =>
              void saveApiKey(keyInput).then(() => {
                setKeyInput('')
                setReplacingKey(false)
              })
            }
            disabled={!keyInput.trim()}
          >
            Save
          </button>
          <button onClick={() => setReplacingKey(false)}>Cancel</button>
        </div>
      )}

      {!transcript && <p className="placeholder">Transcribe this media first (Transcript panel below).</p>}

      {isGenerating && <div className="transcript-status-banner">Generating suggestions…</div>}
      {generationState === 'success' && lastResultFromCache && (
        <div className="transcript-status-banner">Loaded from cache — no API request made.</div>
      )}
      {generationState === 'canceled' && <div className="transcript-status-banner">Canceled.</div>}
      {generationState === 'rate-limited' && lastError && (
        <div className="transcript-error-banner">
          Rate limited{lastError.retryAfterSeconds ? ` — retry in ~${lastError.retryAfterSeconds}s` : ''}.
          <button className="inline-link-button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {generationState === 'error' && lastError && (
        <div className="transcript-error-banner">
          {lastError.message}
          <button className="inline-link-button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}

      <div className="ai-filters">
        <input
          className="ai-search-input"
          placeholder="Search suggestions…"
          value={filters.search}
          onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
        />
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) togglePurposeFilter(e.target.value as CommunicationPurpose)
          }}
        >
          <option value="">Filter by purpose…</option>
          {PURPOSE_VALUES.map((p) => (
            <option key={p} value={p}>
              {filters.purposes.has(p) ? '✓ ' : ''}
              {PURPOSE_LABELS[p]}
            </option>
          ))}
        </select>
        <label className="ai-filter-checkbox">
          <input type="checkbox" checked={filters.statuses.has('accepted')} onChange={() => toggleStatusFilter('accepted')} />
          Accepted
        </label>
        <label className="ai-filter-checkbox">
          <input type="checkbox" checked={filters.statuses.has('rejected')} onChange={() => toggleStatusFilter('rejected')} />
          Rejected
        </label>
        <label className="ai-filter-checkbox">
          <input type="checkbox" checked={filters.lockedOnly} onChange={(e) => setFilters((p) => ({ ...p, lockedOnly: e.target.checked }))} />
          Locked
        </label>
        <label className="ai-filter-checkbox">
          <input
            type="checkbox"
            checked={filters.needsReviewOnly}
            onChange={(e) => setFilters((p) => ({ ...p, needsReviewOnly: e.target.checked }))}
          />
          Needs review
        </label>
        {(filters.purposes.size > 0 || filters.statuses.size > 0 || filters.lockedOnly || filters.needsReviewOnly || filters.search) && (
          <button className="inline-link-button" onClick={() => setFilters(DEFAULT_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>

      {canUndoDelete(media.id) && (
        <div className="transcript-status-banner">
          Suggestion deleted.
          <button className="inline-link-button" onClick={() => undoDelete(media.id)}>
            Undo
          </button>
        </div>
      )}
      </div>

      <ul className="ai-suggestions-list panel-scroll-body editor-scroll">
        {filtered.map((s) => (
          <li key={s.id} className={`ai-suggestion-card ai-suggestion-${s.status}${s.locked ? ' ai-suggestion-locked' : ''}`}>
            <div className="ai-suggestion-header">
              <span className="ai-suggestion-purpose">{PURPOSE_LABELS[s.purpose]}</span>
              <span className="ai-suggestion-confidence">
                {Math.round(s.confidence * 100)}%{s.confidence < NEEDS_REVIEW_THRESHOLD ? ' ⚠' : ''}
              </span>
            </div>
            <button className="ai-suggestion-time" onClick={() => seekTo(s.startTime)}>
              {s.startTime.toFixed(1)}s – {s.endTime.toFixed(1)}s
            </button>
            <textarea
              className="ai-suggestion-visual-text"
              lang="km"
              rows={1}
              value={s.visualText}
              disabled={s.locked}
              onChange={(e) => updateSuggestionText(media.id, s.id, { visualText: e.target.value })}
            />
            <textarea
              className="ai-suggestion-reason"
              rows={1}
              value={s.reason}
              disabled={s.locked}
              onChange={(e) => updateSuggestionText(media.id, s.id, { reason: e.target.value })}
            />
            {s.edited && <span className="ai-suggestion-edited-badge">Edited</span>}

            <div className="ai-suggestion-actions">
              {s.status === 'suggested' && (
                <>
                  <button onClick={() => setSuggestionStatus(media.id, s.id, 'accepted')}>Accept</button>
                  <button onClick={() => setSuggestionStatus(media.id, s.id, 'rejected')}>Reject</button>
                </>
              )}
              {s.status !== 'suggested' && (
                <span className="ai-suggestion-status-label">{s.status === 'accepted' ? 'Accepted' : 'Rejected'}</span>
              )}
              <button onClick={() => toggleLock(media.id, s.id)}>{s.locked ? 'Unlock' : 'Lock'}</button>
              {!s.locked && transcript && (
                <button
                  onClick={() => {
                    const seg = transcript.segments.find((seg2) => seg2.id === s.segmentId)
                    if (seg) void regenerateOne(media.id, seg)
                  }}
                  disabled={isGenerating}
                >
                  Regenerate
                </button>
              )}
              {!s.locked && (
                <button onClick={() => void simplify(media.id, s.id)} disabled={isGenerating}>
                  Simplify
                </button>
              )}
              <button onClick={() => deleteSuggestion(media.id, s.id)}>Delete</button>
            </div>
          </li>
        ))}
        {filtered.length === 0 && allSuggestions.length > 0 && <li className="placeholder">No suggestions match the current filters.</li>}
        {allSuggestions.length === 0 && !isGenerating && (
          <li className="placeholder">No suggestions yet. Click "Generate AI Suggestions" above.</li>
        )}
      </ul>

      {pendingPreview && (
        <CloudConsentModal preview={pendingPreview} onCancel={() => setPendingPreview(null)} onConfirm={handleConfirm} />
      )}
    </div>
  )
}
