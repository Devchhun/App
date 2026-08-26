import { useMemo } from 'react'
import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useTranscript } from './TranscriptContext'
import { formatDuration } from '../media/format'

/** Compact, read-only companion to the full Transcript panel (model
 * selection, GPU status, script alignment, dictionary), which now lives in
 * its own dedicated left-column view -- this is just a quick-glance/seek
 * list, matching the reference layout's left-column transcript column. */
export function TranscriptPreviewList(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { transcripts } = useTranscript()
  const { seekTo, currentTime } = usePlayback()

  const media = items.find((m) => m.id === selectedId)
  const segments = media ? (transcripts[media.id]?.segments ?? []) : []

  const activeSegmentId = useMemo(() => {
    const seg = segments.find((s) => currentTime >= s.startTime && currentTime < s.endTime)
    return seg?.id ?? null
  }, [segments, currentTime])

  if (segments.length === 0) {
    return <p className="placeholder">No transcript yet. Open the Transcript tab (left icon rail) to transcribe.</p>
  }

  return (
    <ul className="transcript-preview-list editor-scroll">
      {segments.map((seg) => (
        <li
          key={seg.id}
          className={seg.id === activeSegmentId ? 'transcript-preview-row transcript-preview-row-active' : 'transcript-preview-row'}
          onClick={() => seekTo(seg.startTime)}
        >
          <span className="transcript-preview-time">{formatDuration(seg.startTime)}</span>
          <span className="transcript-preview-text" lang="km">
            {seg.editedText ?? seg.text}
          </span>
        </li>
      ))}
    </ul>
  )
}
