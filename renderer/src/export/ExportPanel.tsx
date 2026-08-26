import { useEffect, useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useProject } from '../project/ProjectContext'
import { useExport } from './ExportContext'
import { computeExportDurationSeconds, estimateOutputSizeMB, EXPORT_RESOLUTION_VALUES, EXPORT_BITRATE_VALUES, EXPORT_CODEC_VALUES, EXPORT_FRAME_RATE_VALUES, EXPORT_AUDIO_FORMAT_VALUES } from '@shared/export'
import type { ExportCodec } from '@shared/export'
import { formatDuration } from '../media/format'

const RESOLUTION_LABELS: Record<(typeof EXPORT_RESOLUTION_VALUES)[number], string> = {
  '480p': '480P',
  '720p': '720P',
  '1080p': '1080P',
  '2k': '2K',
  '4k': '4K'
}
const BITRATE_LABELS: Record<(typeof EXPORT_BITRATE_VALUES)[number], string> = {
  lower: 'Lower',
  recommended: 'Recommended',
  higher: 'Higher',
  custom: 'Custom'
}
const CODEC_LABELS: Record<ExportCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' }
const AUDIO_FORMAT_LABELS: Record<(typeof EXPORT_AUDIO_FORMAT_VALUES)[number], string> = { aac: 'AAC', mp3: 'MP3' }

interface SectionHeaderProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  expanded: boolean
  onToggleExpand: () => void
}

/** A checkbox (enables/disables this whole section's effect on export) plus
 * an independent expand/collapse chevron -- matches the reference dialog's
 * "✓ Video ▲" / "○ Audio ▲" section headers exactly, as two separate
 * controls rather than one, so toggling the checkbox never accidentally
 * collapses the section (and vice versa). */
function SectionHeader({ label, checked, onCheckedChange, expanded, onToggleExpand }: SectionHeaderProps): JSX.Element {
  return (
    <div className="export-section-title export-section-header">
      <label className="export-checkbox-label">
        <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />
        {label}
      </label>
      <button type="button" className="export-section-chevron" onClick={onToggleExpand} title={expanded ? 'Collapse' : 'Expand'}>
        {expanded ? '▲' : '▼'}
      </button>
    </div>
  )
}

export function ExportPanel(): JSX.Element | null {
  const { items } = useMedia()
  const { sequence } = useSequence()
  const { brandPreset } = useBrandPreset()
  const { projectName } = useProject()
  const { isOpen, closeDialog, capabilities, options, setOptions, pickOutputDir, phase, progress, startExport, cancelExport, resetToForm } = useExport()
  const [expanded, setExpanded] = useState({ video: true, audio: true, gif: false })

  const durationSeconds = useMemo(() => computeExportDurationSeconds(sequence.clips), [sequence.clips])
  const estimatedSizeMB = useMemo(() => estimateOutputSizeMB(durationSeconds, options), [durationSeconds, options])

  // Defaults the Name field to the real project name (not a literal
  // "export" placeholder) the moment the dialog opens with nothing typed
  // yet -- syncs into options.name itself, not just the input's display
  // value, so what's shown and what actually gets submitted always match.
  useEffect(() => {
    if (isOpen && !options.name) setOptions({ name: projectName || 'export' })
  }, [isOpen, options.name, projectName, setOptions])

  if (!isOpen) return null

  const exportDisabled = !options.outputDir || durationSeconds <= 0 || (!options.includeVideo && !options.includeAudio)

  const handleExport = (): void => {
    if (exportDisabled) return
    const mediaById = Object.fromEntries(items.filter((m) => m.stage === 'ready').map((m) => [m.id, { originalPath: m.originalPath }]))
    startExport(sequence, mediaById, brandPreset.defaultAspectRatio)
  }

  const codecAvailable = (codec: ExportCodec): boolean => !capabilities || capabilities.availableCodecs.length === 0 || capabilities.availableCodecs.includes(codec)

  return (
    <div className="modal-overlay" onClick={closeDialog}>
      <div className="modal-panel export-modal" onClick={(e) => e.stopPropagation()}>
        {phase === 'form' && (
          <>
            <div className="modal-header">
              <span>Export</span>
              <button className="modal-close" onClick={closeDialog} title="Close">
                ✕
              </button>
            </div>
            <div className="export-modal-body">
              <div className="export-field-row">
                <label>Name</label>
                <input value={options.name || projectName || 'export'} onChange={(e) => setOptions({ name: e.target.value })} />
              </div>
              <div className="export-field-row">
                <label>Export to</label>
                <div className="export-path-row">
                  <input readOnly value={options.outputDir || 'Choose a folder…'} />
                  <button onClick={() => void pickOutputDir()} title="Choose folder">
                    📁
                  </button>
                </div>
              </div>

              <SectionHeader
                label="Video"
                checked={options.includeVideo}
                onCheckedChange={(checked) => setOptions({ includeVideo: checked })}
                expanded={expanded.video}
                onToggleExpand={() => setExpanded((prev) => ({ ...prev, video: !prev.video }))}
              />
              {expanded.video && (
                <>
                  <div className="export-field-row">
                    <label>Resolution</label>
                    <select disabled={!options.includeVideo} value={options.resolution} onChange={(e) => setOptions({ resolution: e.target.value as typeof options.resolution })}>
                      {EXPORT_RESOLUTION_VALUES.map((r) => (
                        <option key={r} value={r}>
                          {RESOLUTION_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="export-field-row">
                    <label>Bit rate</label>
                    <select disabled={!options.includeVideo} value={options.bitratePreset} onChange={(e) => setOptions({ bitratePreset: e.target.value as typeof options.bitratePreset })}>
                      {EXPORT_BITRATE_VALUES.map((b) => (
                        <option key={b} value={b}>
                          {BITRATE_LABELS[b]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {options.bitratePreset === 'custom' && (
                    <div className="export-field-row">
                      <label>Bitrate (kbps)</label>
                      <input
                        type="number"
                        min={100}
                        disabled={!options.includeVideo}
                        value={options.customBitrateKbps ?? 4000}
                        onChange={(e) => setOptions({ customBitrateKbps: Number(e.target.value) })}
                      />
                    </div>
                  )}
                  <div className="export-field-row">
                    <label>Codec</label>
                    <select disabled={!options.includeVideo} value={options.codec} onChange={(e) => setOptions({ codec: e.target.value as ExportCodec })}>
                      {EXPORT_CODEC_VALUES.map((c) => (
                        <option key={c} value={c} disabled={!codecAvailable(c)}>
                          {CODEC_LABELS[c]}
                          {!codecAvailable(c) ? ' (unavailable)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="export-field-row">
                    <label>Format</label>
                    <select value="mp4" disabled>
                      <option value="mp4">mp4</option>
                    </select>
                  </div>
                  <div className="export-field-row">
                    <label>Frame rate</label>
                    <select disabled={!options.includeVideo} value={options.frameRate} onChange={(e) => setOptions({ frameRate: Number(e.target.value) as typeof options.frameRate })}>
                      {EXPORT_FRAME_RATE_VALUES.map((f) => (
                        <option key={f} value={f}>
                          {f}fps
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="export-color-space">Color space: Rec. 709 SDR</div>
                </>
              )}

              <SectionHeader
                label="Audio"
                checked={options.includeAudio}
                onCheckedChange={(checked) => setOptions({ includeAudio: checked })}
                expanded={expanded.audio}
                onToggleExpand={() => setExpanded((prev) => ({ ...prev, audio: !prev.audio }))}
              />
              {expanded.audio && (
                <div className="export-field-row">
                  <label>Format</label>
                  <select disabled={!options.includeAudio} value={options.audioFormat} onChange={(e) => setOptions({ audioFormat: e.target.value as typeof options.audioFormat })}>
                    {EXPORT_AUDIO_FORMAT_VALUES.map((f) => (
                      <option key={f} value={f}>
                        {AUDIO_FORMAT_LABELS[f]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <SectionHeader
                label="Export GIF"
                checked={options.exportGif}
                onCheckedChange={(checked) => setOptions({ exportGif: checked })}
                expanded={expanded.gif}
                onToggleExpand={() => setExpanded((prev) => ({ ...prev, gif: !prev.gif }))}
              />
            </div>
            {!options.outputDir && <div className="export-inline-hint">Choose an export folder above to enable Export.</div>}
            {options.outputDir && !options.includeVideo && !options.includeAudio && (
              <div className="export-inline-hint">Enable Video or Audio above -- nothing is selected to export.</div>
            )}
            <div className="export-modal-footer">
              <span className="export-footer-stats">
                Duration: {formatDuration(durationSeconds)} | Size: about {estimatedSizeMB < 1 ? '< 1' : Math.round(estimatedSizeMB)} MB
              </span>
              <div className="export-footer-actions">
                <button className="export-cancel-button" onClick={closeDialog}>
                  Cancel
                </button>
                <button className="export-primary-button" disabled={exportDisabled} onClick={handleExport}>
                  Export
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'exporting' && (
          <div className="export-progress-view">
            <div className="modal-header">
              <span>Exporting</span>
            </div>
            <div className="export-progress-stats">
              <div>Video Name: {options.name || projectName}</div>
              <div>Duration: {formatDuration(durationSeconds)}</div>
              <div>Resolution: {RESOLUTION_LABELS[options.resolution]}</div>
              <div>Codec: {CODEC_LABELS[options.codec]}</div>
              <div>Format: mp4</div>
              <div>Frame rate: {options.frameRate}fps</div>
              {progress?.message && <div>{progress.message}</div>}
            </div>
            <div className="export-progress-bar-track">
              <div className="export-progress-bar-fill" style={{ width: `${Math.round(progress?.percent ?? 0)}%` }} />
            </div>
            <div className="export-progress-footer">
              <span>{Math.round(progress?.percent ?? 0)}%</span>
              <button className="export-cancel-button" onClick={cancelExport}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="export-result-view">
            <div className="modal-header">
              <span>Export complete</span>
            </div>
            <p className="export-result-path">{progress?.outputPath}</p>
            <div className="export-modal-footer">
              <button className="export-cancel-button" onClick={resetToForm}>
                Export again
              </button>
              <button className="export-primary-button" onClick={closeDialog}>
                Done
              </button>
            </div>
          </div>
        )}

        {(phase === 'error' || phase === 'canceled') && (
          <div className="export-result-view">
            <div className="modal-header">
              <span>{phase === 'canceled' ? 'Export canceled' : 'Export failed'}</span>
            </div>
            {progress?.message && <p className="export-result-error">{progress.message}</p>}
            <div className="export-modal-footer">
              <button className="export-cancel-button" onClick={closeDialog}>
                Close
              </button>
              <button className="export-primary-button" onClick={resetToForm}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
