import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useNarration } from './NarrationContext'
import { formatDuration } from '../media/format'
import { useConfirm } from '../ui/ConfirmDialog'
import type { NarrationRecordingStatus } from '@shared/narration'
import type { TranscriptSegment } from '@shared/transcription'

type StatusFilter = 'all' | 'pending' | 'recorded' | 'needs-review'

const STATUS_DISPLAY: Record<NarrationRecordingStatus, { icon: string; label: string }> = {
  pending: { icon: '○', label: 'Pending' },
  recording: { icon: '●', label: 'Recording' },
  recorded: { icon: '✓', label: 'Recorded' },
  accepted: { icon: '✓', label: 'Recorded' },
  'needs-review': { icon: '⚠', label: 'Needs Review' }
}

/** Left panel while Story Narration is active -- replaces the Media panel
 * entirely (App.tsx's LeftColumn). Two states: a compact setup form (no
 * video/SRT chosen yet) and the prepared segment script list. */
export function NarrationScriptPanel(): JSX.Element {
  const narration = useNarration()
  if (!narration.state.videoMediaId) return <NarrationSetup />
  return <NarrationSegmentList />
}

function NarrationSetup(): JSX.Element {
  const { items, importFromDialog } = useMedia()
  const narration = useNarration()
  const [selectedVideoId, setSelectedVideoId] = useState('')
  const [srtFileName, setSrtFileName] = useState<string | null>(null)
  const [srtText, setSrtText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const videos = useMemo(() => items.filter((m) => m.kind === 'video' && m.readyToUse), [items])

  const handleImportVideo = async (): Promise<void> => {
    setError(null)
    await importFromDialog()
  }

  const handleImportSrt = async (): Promise<void> => {
    setError(null)
    const result = await window.api.transcription.importSrtFile()
    if (result.canceled || !result.srtText) return
    setSrtFileName(result.fileName ?? 'subtitles.srt')
    setSrtText(result.srtText)
  }

  const canPrepare = !!selectedVideoId && !!srtText && !busy

  const handlePrepare = (): void => {
    if (!canPrepare) return
    const video = videos.find((v) => v.id === selectedVideoId)
    if (!video) return
    setBusy(true)
    setError(null)
    try {
      const result = narration.prepareWorkspace({
        videoMediaId: selectedVideoId,
        srtText: srtText!,
        srtFileName: srtFileName ?? 'subtitles.srt',
        videoDurationSeconds: video.metadata?.durationSeconds ?? 0
      })
      if (result.segmentCount === 0) setError('No valid subtitle segments were found in this SRT file.')
    } finally {
      setBusy(false)
    }
  }

  const selectedVideo = videos.find((v) => v.id === selectedVideoId)

  return (
    <div className="narration-setup">
      <p className="narration-setup-intro">Add a video and its subtitles, then record narration line by line straight into the Timeline.</p>

      {/* Same two-card shape as the AI Dubber setup: each card is the
          import action, and shows what has been picked so far. A tick
          badge marks a done step. */}
      <div className="ai-dubber-setup-buttons">
        <button className={selectedVideo ? 'ai-dubber-setup-add-button narration-setup-card narration-setup-card-done' : 'ai-dubber-setup-add-button narration-setup-card'} onClick={() => void handleImportVideo()}>
          <span className="narration-setup-card-step">{selectedVideo ? '✓' : '1'}</span>
          <span className="ai-dubber-setup-add-button-title">{selectedVideo ? 'Video' : 'Add Video'}</span>
          <span className="narration-setup-card-sub">{selectedVideo ? selectedVideo.fileName : 'MP4, MOV, AVI…'}</span>
        </button>
        <button className={srtFileName ? 'ai-dubber-setup-add-button narration-setup-card narration-setup-card-done' : 'ai-dubber-setup-add-button narration-setup-card'} onClick={() => void handleImportSrt()}>
          <span className="narration-setup-card-step">{srtFileName ? '✓' : '2'}</span>
          <span className="ai-dubber-setup-add-button-title">{srtFileName ? 'Subtitles' : 'Add SRT'}</span>
          <span className="narration-setup-card-sub">{srtFileName ?? '.srt file'}</span>
        </button>
      </div>

      {videos.length > 0 && (
        <label className="narration-setup-field">
          <span>Or use a video already imported</span>
          <select className="settings-select narration-setup-select" value={selectedVideoId} onChange={(e) => setSelectedVideoId(e.target.value)}>
            <option value="">Select an imported video…</option>
            {videos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.fileName}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <div className="voiceover-recorder-error">{error}</div>}

      <button className="narration-setup-prepare-button" disabled={!canPrepare} onClick={handlePrepare}>
        Prepare Narration Workspace
      </button>
    </div>
  )
}

function segmentStatus(narration: ReturnType<typeof useNarration>, segmentId: string): NarrationRecordingStatus {
  return narration.state.segments[segmentId]?.status ?? 'pending'
}

function matchesFilter(status: NarrationRecordingStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'pending') return status === 'pending' || status === 'recording'
  if (filter === 'recorded') return status === 'recorded' || status === 'accepted'
  return status === 'needs-review'
}

function NarrationSegmentList(): JSX.Element {
  const narration = useNarration()
  const { items } = useMedia()
  const confirm = useConfirm()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')

  const acceptedCount = narration.segments.filter((s) => segmentStatus(narration, s.id) === 'accepted').length
  const total = narration.segments.length
  const progressPercent = total > 0 ? Math.round((acceptedCount / total) * 100) : 0

  const handleReplaceSrt = async (): Promise<void> => {
    const result = await window.api.transcription.importSrtFile()
    if (result.canceled || !result.srtText || !narration.state.videoMediaId) return
    const video = items.find((m) => m.id === narration.state.videoMediaId)
    narration.prepareWorkspace({
      videoMediaId: narration.state.videoMediaId,
      srtText: result.srtText,
      srtFileName: result.fileName ?? 'subtitles.srt',
      videoDurationSeconds: video?.metadata?.durationSeconds ?? 0
    })
  }

  const handleRemoveSrt = (): void => {
    void confirm({
      title: 'Remove video and SRT?',
      message: ['Per-segment speaker, take history and progress will be lost.', 'Any voiceover clips already accepted onto the Timeline are kept.'],
      confirmLabel: 'Remove',
      danger: true
    }).then((ok) => {
      if (ok) narration.clearWorkspace()
    })
  }

  const visibleSegments = useMemo(() => {
    const term = search.trim().toLowerCase()
    return narration.segments.filter((seg) => {
      const status = segmentStatus(narration, seg.id)
      if (!matchesFilter(status, filter)) return false
      if (term && !(seg.editedText ?? seg.text).toLowerCase().includes(term)) return false
      return true
    })
  }, [narration, search, filter])

  return (
    <div className="narration-script">
      {/* File bar: which SRT is loaded, and the two things you can do to
          it, as quiet text buttons -- the list below is the point. */}
      <div className="narration-script-header">
        <span className="narration-script-synced" title="Subtitles are in sync with the video" aria-hidden>
          ◆
        </span>
        <span className="narration-script-filename" title={narration.state.srtFileName}>
          {narration.state.srtFileName}
        </span>
        <button className="narration-script-textbutton" onClick={() => void handleReplaceSrt()} title="Replace the SRT file">
          Replace
        </button>
        <button className="narration-script-textbutton narration-script-textbutton-danger" title="Remove this video and SRT, and start over" onClick={handleRemoveSrt}>
          Remove
        </button>
      </div>

      <div className="narration-script-progress-row">
        <div className="narration-script-progress-bar">
          <div className="narration-script-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <span className="narration-script-progress-label">
          <strong>{acceptedCount}</strong> / {total}
        </span>
      </div>

      <input className="media-search-input narration-script-search" placeholder="Search segments…" value={search} onChange={(e) => setSearch(e.target.value)} />

      <div className="narration-script-filters">
        {(['all', 'pending', 'recorded', 'needs-review'] as StatusFilter[]).map((f) => (
          <button key={f} className={filter === f ? 'narration-filter-chip narration-filter-chip-active' : 'narration-filter-chip'} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'pending' ? 'Pending' : f === 'recorded' ? 'Recorded' : 'Needs Review'}
          </button>
        ))}
      </div>

      <div className="narration-script-list editor-scroll">
        {visibleSegments.map((seg) => (
          <SegmentRow key={seg.id} segment={seg} index={narration.segments.indexOf(seg)} />
        ))}
        {visibleSegments.length === 0 && <p className="voiceover-story-hint">No segments match this filter.</p>}
      </div>

      {visibleSegments.length !== total && (
        <div className="narration-script-footer">
          Showing {visibleSegments.length} of {total}
        </div>
      )}
    </div>
  )
}

function SegmentRow({ segment, index }: { segment: TranscriptSegment; index: number }): JSX.Element {
  const narration = useNarration()
  const segState = narration.state.segments[segment.id]
  const status = segState?.status ?? 'pending'
  const isActive = narration.state.currentSegmentId === segment.id
  const display = STATUS_DISPLAY[status]
  const speakerLabel =
    segState?.speaker && segState.speaker !== 'unknown'
      ? `${segState.speaker === 'male' ? 'Male' : 'Female'}${segState.speakerConfidence !== undefined ? ` · Auto ${Math.round(segState.speakerConfidence * 100)}%` : ''}`
      : null

  return (
    <button
      className={isActive ? 'narration-segment-row narration-segment-row-active' : 'narration-segment-row'}
      onClick={() => narration.selectSegment(segment.id)}
    >
      <div className="narration-segment-row-top">
        <span className="narration-segment-number">{index + 1}</span>
        <span className="narration-segment-time">
          {formatDuration(segment.startTime)} – {formatDuration(segment.endTime)}
        </span>
      </div>
      <div className="narration-segment-text">{segment.editedText ?? segment.text}</div>
      <div className="narration-segment-row-bottom">
        {speakerLabel && <span className="narration-segment-speaker-tag">{speakerLabel}</span>}
        <span className={`narration-row-status narration-row-status-${status}`}>
          <span aria-hidden>{display.icon}</span> {display.label}
        </span>
      </div>
    </button>
  )
}
