import type { TranscriptSegment } from '@shared/transcription'

interface Props {
  segments: TranscriptSegment[]
  duration: number
  pixelsPerSecond: number
  activeSegmentId: string | null
  onSeek: (time: number) => void
  height: number
  hidden?: boolean
}

export function CaptionsTrack({ segments, duration, pixelsPerSecond, activeSegmentId, onSeek, height, hidden }: Props): JSX.Element {
  const widthPx = Math.max(1, Math.round(duration * pixelsPerSecond))

  return (
    <div
      className={`timeline-track timeline-track-captions${hidden ? ' timeline-track-hidden' : ''}`}
      style={{ width: widthPx, height }}
      data-track-kind="caption"
    >
      {segments.map((seg) => {
        const left = seg.startTime * pixelsPerSecond
        const width = Math.max(2, (seg.endTime - seg.startTime) * pixelsPerSecond)
        const text = seg.editedText ?? seg.text
        const classes = [
          'timeline-caption-block',
          seg.needsReview ? 'timeline-caption-review' : '',
          seg.id === activeSegmentId ? 'timeline-caption-active' : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={seg.id}
            className={classes}
            style={{ left, width }}
            title={text}
            onClick={(e) => {
              e.stopPropagation()
              onSeek(seg.startTime)
            }}
          >
            <span className="timeline-caption-text" lang="km">
              {text}
            </span>
          </button>
        )
      })}
    </div>
  )
}
