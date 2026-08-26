import type { TranscriptSegment } from '@shared/transcription'
import { formatDuration } from '../media/format'

interface Props {
  segment: TranscriptSegment
  isActive: boolean
  onSeek: () => void
  onTextChange: (text: string) => void
  onSelectText?: (text: string) => void
}

export function SegmentRow({ segment, isActive, onSeek, onTextChange, onSelectText }: Props): JSX.Element {
  const displayText = segment.editedText ?? segment.text

  return (
    <li className={`segment-row${isActive ? ' segment-row-active' : ''}${segment.needsReview ? ' segment-row-review' : ''}`}>
      <button className="segment-time" onClick={onSeek} title="Seek preview to this segment">
        {formatDuration(segment.startTime)}
      </button>
      <div className="segment-text-wrap">
        <textarea
          className="segment-text"
          value={displayText}
          onChange={(e) => onTextChange(e.target.value)}
          onSelect={(e) => {
            const el = e.currentTarget
            const selected = el.value.substring(el.selectionStart, el.selectionEnd)
            onSelectText?.(selected)
          }}
          rows={1}
          lang="km"
        />
        <div className="segment-meta">
          <span className="segment-confidence">{Math.round(segment.confidence * 100)}%</span>
          {segment.needsReview && <span className="segment-review-badge">Needs review</span>}
          {segment.editedText !== undefined && <span className="segment-edited-badge">Edited</span>}
        </div>
      </div>
    </li>
  )
}
