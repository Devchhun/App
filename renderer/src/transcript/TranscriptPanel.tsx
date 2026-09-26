import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { usePlaybackTime, usePlaybackControls } from '../playback/PlaybackContext'
import { useTranscript } from './TranscriptContext'
import { SegmentRow } from './SegmentRow'
import { CorrectionDictionaryModal } from '../dictionary/CorrectionDictionaryModal'
import { useConfirm } from '../ui/ConfirmDialog'
import type { TranscriptionLanguage } from '@shared/transcription'
import { useUiState } from '../nav/UiStateContext'

const LANGUAGE_OPTIONS: Array<{ value: TranscriptionLanguage; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'km', label: 'Khmer' },
  { value: 'en', label: 'English' }
]

const ACTIVE_STAGES = new Set(['queued', 'preparing-audio', 'loading-model', 'downloading-model', 'transcribing', 'paused'])

export function TranscriptPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { currentTime } = usePlaybackTime()
  const { seekTo } = usePlaybackControls()
  const confirm = useConfirm()
  const { openSettings } = useUiState()
  const {
    deviceInfo,
    models,
    selectedModelId,
    language,
    modelDownloadProgress,
    workerStatus,
    cancelModelDownload,
    transcripts,
    transcriptStatus,
    startTranscription,
    pauseTranscription,
    resumeTranscription,
    cancelTranscription,
    retryTranscription,
    updateSegmentText,
    scriptAlignments,
    alignScript
  } = useTranscript()

  const [scriptText, setScriptText] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [dictionaryOpen, setDictionaryOpen] = useState(false)
  const [selectedSegmentText, setSelectedSegmentText] = useState('')

  const media = items.find((m) => m.id === selectedId)
  const status = media ? transcriptStatus[media.id] : undefined
  const transcript = media ? transcripts[media.id] : undefined
  const alignment = media ? scriptAlignments[media.id] : undefined
  const isActive = status ? ACTIVE_STAGES.has(status.stage) : false
  const isPaused = status?.stage === 'paused'

  const selectedModel = models.find((m) => m.id === selectedModelId)
  const modelReady = selectedModel?.downloaded ?? false

  const matchCount = useMemo(() => {
    if (!transcript || !searchTerm) return 0
    return transcript.segments.reduce((count, seg) => {
      const text = seg.editedText ?? seg.text
      if (!searchTerm) return count
      return count + text.split(searchTerm).length - 1
    }, 0)
  }, [transcript, searchTerm])

  const activeSegmentId = useMemo(() => {
    if (!transcript) return null
    const seg = transcript.segments.find((s) => currentTime >= s.startTime && currentTime < s.endTime)
    return seg?.id ?? null
  }, [transcript, currentTime])

  if (!media) {
    return <div className="transcript-empty">Select a media item to transcribe.</div>
  }

  const handleReplaceAll = async (): Promise<void> => {
    if (!transcript || !searchTerm) return
    const confirmed = await confirm({
      title: `Replace ${matchCount} occurrence${matchCount === 1 ? '' : 's'}?`,
      message: `Every "${searchTerm}" in the transcript becomes "${replaceTerm}". This can't be undone from here.`,
      confirmLabel: 'Replace all'
    })
    if (!confirmed) return
    for (const seg of transcript.segments) {
      const text = seg.editedText ?? seg.text
      if (text.includes(searchTerm)) {
        updateSegmentText(media.id, seg.id, text.split(searchTerm).join(replaceTerm))
      }
    }
  }

  const handleStart = (): void => {
    startTranscription(media.id, media.originalPath, language)
  }

  return (
    <div className="transcript-panel">
      <div className="panel-fixed-head">
      {/* Language / model / GPU setup moved to Settings > Transcription
          (TranscriptionSettingsCard.tsx); this caption is the one-line
          summary and the way there. */}
      <button className="transcript-setup-caption" title="Open Settings > Transcription" onClick={() => openSettings('transcription')}>
        <span>{LANGUAGE_OPTIONS.find((o) => o.value === language)?.label ?? language}</span>
        <span className="transcript-setup-sep">&middot;</span>
        <span>{selectedModel ? `${selectedModel.label}${modelReady ? ' \u2713' : ' (not downloaded)'}` : 'No model'}</span>
        <span className="transcript-setup-sep">&middot;</span>
        <span>{deviceInfo ? (deviceInfo.device === 'cuda' ? 'GPU' : 'CPU') : '\u2026'}</span>
      </button>

      <div className="transcript-toolbar">
        <div className="transcript-toolbar-actions">
          {!modelReady && (
            <button onClick={() => openSettings('transcription')} disabled={modelDownloadProgress?.stage === 'downloading'}>
              {modelDownloadProgress?.stage === 'downloading' ? 'Downloading model\u2026' : 'Download model\u2026'}
            </button>
          )}

          {!isActive && (
            <button onClick={handleStart} disabled={!modelReady}>
              {status?.stage === 'error' || status?.stage === 'canceled' ? 'Restart' : 'Start Transcription'}
            </button>
          )}
          {isActive && !isPaused && <button onClick={pauseTranscription}>Pause</button>}
          {isPaused && <button onClick={resumeTranscription}>Resume</button>}
          {isActive && <button onClick={cancelTranscription}>Cancel</button>}
          {(status?.stage === 'error' || status?.stage === 'canceled') && (
            <button onClick={() => retryTranscription(media.id)}>Retry</button>
          )}
        </div>

        <button className="transcript-toolbar-secondary" onClick={() => setDictionaryOpen(true)}>
          Dictionary…
        </button>
      </div>

      {workerStatus && workerStatus.stage !== 'ready' && (
        <div className="transcript-status-banner">
          Setting up local AI environment: {workerStatus.stage}
          {workerStatus.message ? ` — ${workerStatus.message}` : ''}
        </div>
      )}

      {modelDownloadProgress && modelDownloadProgress.stage === 'downloading' && (
        <div className="transcript-status-banner">
          Downloading {modelDownloadProgress.modelId}: {Math.round(modelDownloadProgress.percent)}%
          <button className="inline-link-button" onClick={cancelModelDownload}>
            Cancel download
          </button>
        </div>
      )}

      {status && isActive && (
        <div className="transcript-status-banner">
          {status.stage} — {Math.round(status.percent)}%
        </div>
      )}
      {status?.stage === 'error' && <div className="transcript-error-banner">{status.errorMessage}</div>}

      <div className="transcript-script-input">
        <textarea
          placeholder="Paste a corrected script here to align it with the audio…"
          value={scriptText}
          onChange={(e) => setScriptText(e.target.value)}
          rows={2}
          lang="km"
        />
        <button onClick={() => void alignScript(media.id, scriptText)} disabled={!transcript || !scriptText.trim()}>
          Align Script
        </button>
      </div>
      {alignment && (
        <div className="transcript-alignment-result">
          {alignment.map((seg, i) => (
            <div key={i} className={`alignment-row${seg.confidence < 0.5 ? ' alignment-row-low' : ''}`}>
              <button className="segment-time" onClick={() => seekTo(seg.startTime)}>
                {seg.startTime.toFixed(1)}s
              </button>
              <span>{seg.text}</span>
              <span className="alignment-confidence">{Math.round(seg.confidence * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      <div className="transcript-search-bar">
        <input placeholder="Search…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
        <input placeholder="Replace with…" value={replaceTerm} onChange={(e) => setReplaceTerm(e.target.value)} />
        <button onClick={() => void handleReplaceAll()} disabled={!searchTerm}>
          Replace All {searchTerm ? `(${matchCount})` : ''}
        </button>
        {selectedSegmentText && (
          <button onClick={() => setDictionaryOpen(true)}>Add "{selectedSegmentText.slice(0, 20)}" to dictionary</button>
        )}
      </div>
      </div>

      <ul className="segment-list panel-scroll-body editor-scroll">
        {transcript?.segments.map((seg) => (
          <SegmentRow
            key={seg.id}
            segment={seg}
            isActive={seg.id === activeSegmentId}
            onSeek={() => seekTo(seg.startTime)}
            onTextChange={(text) => updateSegmentText(media.id, seg.id, text)}
            onSelectText={setSelectedSegmentText}
          />
        ))}
        {!transcript && !isActive && <li className="transcript-empty-hint">No transcript yet. Choose a model and click Start Transcription.</li>}
      </ul>

      {dictionaryOpen && (
        <CorrectionDictionaryModal
          onClose={() => setDictionaryOpen(false)}
          prefillOriginal={selectedSegmentText || undefined}
        />
      )}
    </div>
  )
}
