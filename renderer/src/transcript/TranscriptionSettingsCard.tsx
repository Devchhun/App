import { useState } from 'react'
import { useTranscript } from './TranscriptContext'
import type { TranscriptionLanguage, WhisperModelSize, GpuVerificationResult } from '@shared/transcription'

const LANGUAGE_OPTIONS: Array<{ value: TranscriptionLanguage; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'km', label: 'Khmer' },
  { value: 'en', label: 'English' }
]

/** Settings › Transcription: the Whisper language/model choice, model
 * downloads, and the GPU/CUDA diagnostics that used to crowd the top of
 * the Transcript panel. These are per-machine setup, not per-transcript
 * work, which is why they live here. */
export function TranscriptionSettingsCard(): JSX.Element {
  const {
    deviceInfo,
    retryGpuDetection,
    verifyGpu,
    models,
    selectedModelId,
    setSelectedModelId,
    language,
    setLanguage,
    modelDownloadProgress,
    workerStatus,
    downloadModel,
    cancelModelDownload
  } = useTranscript()
  const [gpuVerifying, setGpuVerifying] = useState(false)
  const [gpuVerifyResult, setGpuVerifyResult] = useState<GpuVerificationResult | null>(null)

  const selectedModel = models.find((m) => m.id === selectedModelId)
  const modelReady = selectedModel?.downloaded ?? false
  const downloading = modelDownloadProgress?.stage === 'downloading'

  const handleVerifyGpu = async (): Promise<void> => {
    setGpuVerifying(true)
    setGpuVerifyResult(null)
    try {
      setGpuVerifyResult(await verifyGpu())
    } finally {
      setGpuVerifying(false)
    }
  }

  return (
    <>
      <div className="settings-section">
        <h3 className="settings-section-title">Transcription</h3>

        <div className="settings-row">
          <span className="settings-row-label">
            Language
            <span className="settings-row-hint">What the speakers say -- Auto-detect works for mixed Khmer/English</span>
          </span>
          <select className="settings-select" value={language} onChange={(e) => setLanguage(e.target.value as TranscriptionLanguage)}>
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-row-label">
            Whisper model
            <span className="settings-row-hint">Bigger is more accurate but slower; ✓ marks models already downloaded</span>
          </span>
          <div className="settings-row-controls">
            <select className="settings-select" value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value as WhisperModelSize)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.approxSizeMb} MB){m.downloaded ? ' ✓' : ''}
                </option>
              ))}
            </select>
            {!modelReady && !downloading && (
              <button className="settings-button" onClick={() => void downloadModel(selectedModelId)}>
                Download
              </button>
            )}
            {downloading && (
              <button className="settings-button" onClick={cancelModelDownload}>
                Cancel ({Math.round(modelDownloadProgress?.percent ?? 0)}%)
              </button>
            )}
          </div>
        </div>

        {downloading && (
          <div className="settings-progress" aria-label="Model download">
            <span className="settings-progress-fill" style={{ width: `${Math.round(modelDownloadProgress?.percent ?? 0)}%` }} />
          </div>
        )}

        {workerStatus && workerStatus.stage !== 'ready' && (
          <p className="settings-note">
            Setting up local AI environment: {workerStatus.stage}
            {workerStatus.message ? ` — ${workerStatus.message}` : ''}
          </p>
        )}
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Compute device</h3>

        <div className="settings-row">
          <span className="settings-row-label">Device</span>
          <span className="settings-value" title={deviceInfo?.reason}>
            {deviceInfo ? (deviceInfo.device === 'cuda' ? `GPU · ${deviceInfo.cudaDeviceName ?? 'CUDA'}` : 'CPU') : '…'}
            {deviceInfo?.computeType ? ` · ${deviceInfo.computeType}` : ''}
            {deviceInfo?.verified ? ' · verified' : ''}
          </span>
        </div>

        {(deviceInfo?.driverVersion || deviceInfo?.cublasVersion || deviceInfo?.cudnnVersion || deviceInfo?.ctranslate2Version) && (
          <div className="settings-row">
            <span className="settings-row-label">Libraries</span>
            <span className="settings-chips">
              {deviceInfo?.driverVersion && <span className="settings-chip">driver {deviceInfo.driverVersion}</span>}
              {deviceInfo?.cublasVersion && <span className="settings-chip">cuBLAS {deviceInfo.cublasVersion}</span>}
              {deviceInfo?.cudnnVersion && <span className="settings-chip">cuDNN {deviceInfo.cudnnVersion}</span>}
              {deviceInfo?.ctranslate2Version && <span className="settings-chip">CTranslate2 {deviceInfo.ctranslate2Version}</span>}
            </span>
          </div>
        )}

        <div className="settings-row">
          <span className="settings-row-label">
            Diagnostics
            <span className="settings-row-hint">The real test loads the model on the GPU once; first run can take ~2 min</span>
          </span>
          <div className="settings-row-controls">
            <button className="settings-button" onClick={() => void retryGpuDetection()}>
              Retry detection
            </button>
            <button className="settings-button" onClick={() => void handleVerifyGpu()} disabled={gpuVerifying}>
              {gpuVerifying ? 'Testing…' : 'Run real GPU test'}
            </button>
          </div>
        </div>

        {gpuVerifyResult && (
          <p className={gpuVerifyResult.ok ? 'settings-note settings-note-ok' : 'settings-note settings-note-error'}>
            {gpuVerifyResult.ok
              ? `OK: load ${gpuVerifyResult.loadTimeSeconds?.toFixed(1)}s, infer ${gpuVerifyResult.inferenceTimeSeconds?.toFixed(2)}s`
              : `Failed: ${gpuVerifyResult.error}`}
          </p>
        )}
      </div>
    </>
  )
}
