import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useTranscript } from './TranscriptContext'
import { SegmentRow } from './SegmentRow'
import { CorrectionDictionaryModal } from '../dictionary/CorrectionDictionaryModal'
import type { TranscriptionLanguage, WhisperModelSize, GpuVerificationResult } from '@shared/transcription'

const LANGUAGE_OPTIONS: Array<{ value: TranscriptionLanguage; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'km', label: 'Khmer' },
  { value: 'en', label: 'English' }
]

const ACTIVE_STAGES = new Set(['queued', 'preparing-audio', 'loading-model', 'downloading-model', 'transcribing', 'paused'])

export function TranscriptPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { currentTime, seekTo } = usePlayback()
  const {
    deviceInfo,
    retryGpuDetection,
    verifyGpu,
    models,
    selectedModelId,
    setSelectedModelId,
    modelDownloadProgress,
    workerStatus,
    downloadModel,
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

  const [language, setLanguage] = useState<TranscriptionLanguage>('auto')
  const [scriptText, setScriptText] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [gpuVerifying, setGpuVerifying] = useState(false)
  const [gpuVerifyResult, setGpuVerifyResult] = useState<GpuVerificationResult | null>(null)
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

  const handleVerifyGpu = async (): Promise<void> => {
    setGpuVerifying(true)
    setGpuVerifyResult(null)
    try {
      const result = await verifyGpu()
      setGpuVerifyResult(result)
    } finally {
      setGpuVerifying(false)
    }
  }

  if (!media) {
    return <div className="transcript-empty">Select a media item to transcribe.</div>
  }

  const handleReplaceAll = (): void => {
    if (!transcript || !searchTerm) return
    if (!window.confirm(`Replace ${matchCount} occurrence(s) of "${searchTerm}"? This cannot be undone here.`)) return
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
      <div className="transcript-toolbar">
        <label>
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value as TranscriptionLanguage)} disabled={isActive}>
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Model
          <select
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value as WhisperModelSize)}
            disabled={isActive}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.approxSizeMb} MB){m.downloaded ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="transcript-toolbar-actions">
          {!modelReady && (
            <button onClick={() => void downloadModel(selectedModelId)} disabled={modelDownloadProgress?.stage === 'downloading'}>
              Download model
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

      <div className="gpu-status-bar">
        <span className="device-badge" title={deviceInfo?.reason}>
          {deviceInfo ? (deviceInfo.device === 'cuda' ? `GPU: ${deviceInfo.cudaDeviceName ?? 'CUDA'}` : 'CPU') : '…'}
          {deviceInfo?.computeType ? ` · ${deviceInfo.computeType}` : ''}
          {deviceInfo?.verified ? ' · verified' : ''}
        </span>
        {deviceInfo?.driverVersion && <span className="gpu-detail">driver {deviceInfo.driverVersion}</span>}
        {deviceInfo?.cublasVersion && <span className="gpu-detail">cuBLAS {deviceInfo.cublasVersion}</span>}
        {deviceInfo?.cudnnVersion && <span className="gpu-detail">cuDNN {deviceInfo.cudnnVersion}</span>}
        {deviceInfo?.ctranslate2Version && <span className="gpu-detail">CTranslate2 {deviceInfo.ctranslate2Version}</span>}
        <span className="gpu-status-links">
          <button className="inline-link-button" onClick={() => void retryGpuDetection()}>
            Retry GPU Detection
          </button>
          <button className="inline-link-button" onClick={() => void handleVerifyGpu()} disabled={gpuVerifying}>
            {gpuVerifying ? 'Testing GPU (up to ~2 min on first use)…' : 'Run real GPU test'}
          </button>
        </span>
        {gpuVerifyResult && (
          <span className={gpuVerifyResult.ok ? 'gpu-verify-ok' : 'gpu-verify-fail'}>
            {gpuVerifyResult.ok
              ? `OK: load ${gpuVerifyResult.loadTimeSeconds?.toFixed(1)}s, infer ${gpuVerifyResult.inferenceTimeSeconds?.toFixed(2)}s`
              : `Failed: ${gpuVerifyResult.error}`}
          </span>
        )}
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
        <button onClick={handleReplaceAll} disabled={!searchTerm}>
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
