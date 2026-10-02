import { exportOverlayFor } from '@shared/videoOverlay'
import { useEffect, useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useProject } from '../project/ProjectContext'
import { useExport } from './ExportContext'
import {
  computeExportDurationSeconds,
  estimateOutputSizeMB,
  EXPORT_RESOLUTION_VALUES,
  EXPORT_BITRATE_VALUES,
  EXPORT_CODEC_VALUES,
  EXPORT_FRAME_RATE_VALUES,
  EXPORT_AUDIO_FORMAT_VALUES
} from '@shared/export'
import type { ExportCodec } from '@shared/export'
import { buildDubbingSrt } from '@shared/dubbingSrt'
import { formatDuration } from '../media/format'
import { useAiDubber } from '../dubbing/AiDubberContext'
import { useScenes } from '../scenes/SceneContext'
import { sceneFadeSeconds } from '../templates/animation'
import { plainTextLook, PLAIN_TEXT_POSITION, type TextOverlay } from '@shared/plainText'

const RESOLUTION_LABELS: Record<(typeof EXPORT_RESOLUTION_VALUES)[number], string> = {
  '480p': '480P', '720p': '720P', '1080p': '1080P', '2k': '2K', '4k': '4K'
}
const BITRATE_LABELS: Record<(typeof EXPORT_BITRATE_VALUES)[number], string> = {
  lower: 'Lower', recommended: 'Recommended', higher: 'Higher', custom: 'Custom'
}
const CODEC_LABELS: Record<ExportCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' }
const AUDIO_FORMAT_LABELS: Record<(typeof EXPORT_AUDIO_FORMAT_VALUES)[number], string> = { aac: 'AAC', mp3: 'MP3' }

interface SectionHeaderProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  expanded: boolean
  onToggleExpand: () => void
  disabled?: boolean
}

function SectionHeader({ label, checked, onCheckedChange, expanded, onToggleExpand, disabled = false }: SectionHeaderProps): JSX.Element {
  return (
    <div className="export-section-title export-section-header">
      <label className="export-checkbox-label">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onCheckedChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      <button type="button" className="export-section-chevron" onClick={onToggleExpand} title={expanded ? 'Collapse' : 'Expand'}>
        {expanded ? '⌃' : '⌄'}
      </button>
    </div>
  )
}

function ExportPreview({ src, portrait = false }: { src?: string; portrait?: boolean }): JSX.Element {
  return (
    <div className={`export-preview-frame${portrait ? ' export-preview-frame-portrait' : ''}`}>
      {src ? <img src={src} alt="Project preview" draggable={false} /> : <div className="export-preview-empty"><span>▶</span><small>Project preview</small></div>}
      <span className="export-preview-chip">Preview</span>
    </div>
  )
}

function ExportSummary({ name, duration, size, resolution, bitrate, codec, frameRate }: {
  name: string
  duration: number
  size: number
  resolution: string
  bitrate: string
  codec: string
  frameRate: number
}): JSX.Element {
  const rows = [
    ['Video name', name],
    ['Duration', formatDuration(duration)],
    ['Size', `${size < 1 ? '< 1' : Math.round(size)} MB (estimated)`],
    ['Resolution', resolution],
    ['Bitrate', bitrate],
    ['Codec', codec],
    ['Format', 'mp4'],
    ['Color space', 'Rec. 709 SDR'],
    ['Frame rate', `${frameRate}fps`]
  ]
  return <div className="export-summary-card"><h2>Exporting</h2>{rows.map(([label, value]) => <div className="export-summary-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
}

export function ExportPanel(): JSX.Element | null {
  const { items } = useMedia()
  const { sequence } = useSequence()
  const { brandPreset } = useBrandPreset()
  const { scenesByMedia } = useScenes()
  const { projectName } = useProject()
  const { isOpen, closeDialog, capabilities, options, setOptions, pickOutputDir, phase, progress, startExport, cancelExport, resetToForm } = useExport()
  const aiDubber = useAiDubber()
  const [expanded, setExpanded] = useState({ video: true, audio: false, gif: false, srt: false })
  /** Where the SRT went (or why it didn't) for the last Export click. */
  const [srtResult, setSrtResult] = useState<{ path?: string; error?: string } | null>(null)
  const [shareTarget, setShareTarget] = useState<'tiktok' | 'youtube'>('tiktok')
  const [visibility, setVisibility] = useState('Private')

  const durationSeconds = useMemo(() => computeExportDurationSeconds(sequence.clips), [sequence.clips])
  const estimatedSizeMB = useMemo(() => estimateOutputSizeMB(durationSeconds, options), [durationSeconds, options])
  // The fastest frame rate among the videos used: exporting above it only
  // repeats frames -- the same motion, twice the work at 60 for a 30 fps film.
  const sourceFps = useMemo(() => {
    let fps = 0
    for (const clip of sequence.clips) {
      if (clip.type !== 'video') continue
      fps = Math.max(fps, items.find((item) => item.id === clip.mediaId)?.metadata?.frameRate ?? 0)
    }
    return Math.round(fps)
  }, [items, sequence.clips])
  const previewUrl = useMemo(() => {
    const orderedVisualClips = [...sequence.clips].filter((clip) => clip.type === 'video' || clip.type === 'image').sort((a, b) => a.startTime - b.startTime)
    for (const clip of orderedVisualClips) {
      const media = items.find((item) => item.id === clip.mediaId)
      if (media?.thumbnailUrl) return media.thumbnailUrl
    }
    return items.find((item) => item.thumbnailUrl)?.thumbnailUrl
  }, [items, sequence.clips])

  // The project's name is filled in once, as the dialog opens -- not again
  // whenever the field is empty: that refilled "Untitled Project" the moment
  // it was cleared, so the name could not be deleted and retyped.
  useEffect(() => {
    if (isOpen && !options.name) setOptions({ name: projectName || 'export' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, [isOpen])

  useEffect(() => {
    if (isOpen) setSrtResult(null)
  }, [isOpen])

  if (!isOpen) return null

  // The SRT is the AI Dubber's subtitles -- the lines that carry speakers,
  // genders and voices. Nothing to write until there are some.
  const srtLineCount = aiDubber.segments.length
  const mediaExport = (options.includeVideo || options.includeAudio) && durationSeconds > 0
  const srtExport = options.exportSrt && srtLineCount > 0
  const exportDisabled = !options.outputDir || (!mediaExport && !srtExport)
  const exportName = options.name || projectName || 'export'
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)))

  const handleExport = async (): Promise<void> => {
    if (exportDisabled) return
    setSrtResult(null)
    if (srtExport) {
      const content = buildDubbingSrt(aiDubber.segments, aiDubber.state)
      const written = await window.api.export.writeTextFile(options.outputDir, exportName, '.srt', content)
      setSrtResult(written.ok ? { path: written.path } : { error: written.error })
    }
    if (!mediaExport) return
    const mediaById = Object.fromEntries(items.filter((m) => m.readyToUse).map((m) => [m.id, { originalPath: m.originalPath }]))
    // AI Dubber's Subtitle & Blur: burned into the picture when switched on.
    // Add Text's texts on shown tracks are burned in with the subtitles.
    const hiddenTracks = new Set(sequence.tracks.filter((t) => t.hidden).map((t) => t.id))
    const texts: TextOverlay[] = Object.values(scenesByMedia)
      .flat()
      .filter((scene) => scene.templateId === 'plain-text' && scene.status !== 'rejected' && !hiddenTracks.has(scene.track) && scene.visualText.trim())
      .map((scene) => {
        const fade = sceneFadeSeconds(scene, brandPreset.animationIntensity)
        return { start: scene.startTime, end: scene.endTime, text: scene.visualText, position: scene.position ?? PLAIN_TEXT_POSITION, look: plainTextLook(scene), fadeInSeconds: fade.fadeIn, fadeOutSeconds: fade.fadeOut }
      })
    const overlay = exportOverlayFor(aiDubber.videoOverlay, aiDubber.overlayLines)
    startExport(sequence, mediaById, brandPreset.defaultAspectRatio, texts.length > 0 ? { ...overlay, texts } : overlay)
  }
  const codecAvailable = (codec: ExportCodec): boolean => !capabilities || capabilities.availableCodecs.length === 0 || capabilities.availableCodecs.includes(codec)
  const openShareSite = (): void => {
    window.open(shareTarget === 'tiktok' ? 'https://www.tiktok.com/upload' : 'https://studio.youtube.com', '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="modal-overlay export-overlay" onClick={phase === 'exporting' ? undefined : closeDialog}>
      <div className="modal-panel export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-head">
          <strong>{phase === 'success' ? 'Export complete' : 'Export'}</strong>
          {phase !== 'exporting' && <button className="modal-close" onClick={closeDialog} title="Close">×</button>}
        </div>

        {phase === 'form' && (
          <>
            <div className="export-form-layout">
              <aside className="export-preview-column">
                <ExportPreview src={previewUrl} />
                <div className="export-preview-meta"><span>Original project</span><strong>{brandPreset.defaultAspectRatio}</strong></div>
              </aside>
              <div className="export-settings-scroll">
                <div className="export-field-row"><label>Name</label><input value={options.name} placeholder={projectName || 'export'} onChange={(e) => setOptions({ name: e.target.value })} /></div>
                <div className="export-field-row">
                  <label>Export to</label>
                  <div className="export-path-row"><input readOnly value={options.outputDir || 'Choose a folder…'} title={options.outputDir} /><button onClick={() => void pickOutputDir()} title="Choose folder">▣</button></div>
                </div>
                <SectionHeader label="Video" checked={options.includeVideo} onCheckedChange={(checked) => setOptions({ includeVideo: checked })} expanded={expanded.video} onToggleExpand={() => setExpanded((p) => ({ ...p, video: !p.video }))} />
                {expanded.video && <div className="export-section-fields">
                  <div className="export-field-row"><label>Resolution</label><select disabled={!options.includeVideo} value={options.resolution} onChange={(e) => setOptions({ resolution: e.target.value as typeof options.resolution })}>{EXPORT_RESOLUTION_VALUES.map((r) => <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>)}</select></div>
                  <div className="export-field-row"><label>Bit rate</label><select disabled={!options.includeVideo} value={options.bitratePreset} onChange={(e) => setOptions({ bitratePreset: e.target.value as typeof options.bitratePreset })}>{EXPORT_BITRATE_VALUES.map((b) => <option key={b} value={b}>{BITRATE_LABELS[b]}</option>)}</select></div>
                  {options.bitratePreset === 'custom' && <div className="export-field-row"><label>Bitrate (kbps)</label><input type="number" min={100} disabled={!options.includeVideo} value={options.customBitrateKbps ?? 4000} onChange={(e) => setOptions({ customBitrateKbps: Number(e.target.value) })} /></div>}
                  <div className="export-field-row"><label>Codec</label><select disabled={!options.includeVideo} value={options.codec} onChange={(e) => setOptions({ codec: e.target.value as ExportCodec })}>{EXPORT_CODEC_VALUES.map((c) => <option key={c} value={c} disabled={!codecAvailable(c)}>{CODEC_LABELS[c]}{!codecAvailable(c) ? ' (unavailable)' : ''}</option>)}</select></div>
                  <div className="export-field-row"><label>Format</label><select value="mp4" disabled><option>mp4</option></select></div>
                  <div className="export-field-row"><label>Frame rate</label><select disabled={!options.includeVideo} value={options.frameRate} onChange={(e) => setOptions({ frameRate: Number(e.target.value) as typeof options.frameRate })}>{EXPORT_FRAME_RATE_VALUES.map((f) => <option key={f} value={f}>{f}fps</option>)}</select></div>
                  {options.includeVideo && sourceFps > 0 && options.frameRate > sourceFps + 1 ? (
                    <p className="export-field-hint">Your video is {sourceFps}fps. {options.frameRate}fps takes about {Math.round((options.frameRate / sourceFps) * 10) / 10}× longer to export and looks the same.</p>
                  ) : null}
                  <div className="export-color-space">Color space: Rec. 709 SDR</div>
                </div>}
                <SectionHeader label="Audio" checked={options.includeAudio} onCheckedChange={(checked) => setOptions({ includeAudio: checked })} expanded={expanded.audio} onToggleExpand={() => setExpanded((p) => ({ ...p, audio: !p.audio }))} />
                {expanded.audio && <div className="export-section-fields"><div className="export-field-row"><label>Format</label><select disabled={!options.includeAudio} value={options.audioFormat} onChange={(e) => setOptions({ audioFormat: e.target.value as typeof options.audioFormat })}>{EXPORT_AUDIO_FORMAT_VALUES.map((f) => <option key={f} value={f}>{AUDIO_FORMAT_LABELS[f]}</option>)}</select></div></div>}
                <SectionHeader label="Export GIF" checked={options.exportGif} onCheckedChange={(checked) => setOptions({ exportGif: checked })} expanded={expanded.gif} onToggleExpand={() => setExpanded((p) => ({ ...p, gif: !p.gif }))} />
                <SectionHeader
                  label="Export SRT"
                  checked={options.exportSrt && srtLineCount > 0}
                  disabled={srtLineCount === 0}
                  onCheckedChange={(checked) => setOptions({ exportSrt: checked })}
                  expanded={expanded.srt}
                  onToggleExpand={() => setExpanded((p) => ({ ...p, srt: !p.srt }))}
                />
                {expanded.srt && (
                  <div className="export-section-fields export-srt-note">
                    {srtLineCount > 0 ? (
                      <>
                        <p>{srtLineCount} AI Dubber subtitle{srtLineCount === 1 ? '' : 's'}, saved as <strong>{exportName}.srt</strong>.</p>
                        <p>Keeps each line's speaker, male/female, voice, pitch, speed and volume. Import this SRT into AI Dubber again and they come back as they were.</p>
                      </>
                    ) : (
                      <p>Add subtitles in AI Dubber (Auto SRT or Add SRT) to export them.</p>
                    )}
                  </div>
                )}
                {!options.outputDir && <div className="export-inline-hint">Choose an export folder to continue.</div>}
                {!mediaExport && !srtExport && <div className="export-inline-hint">Enable Video, Audio or SRT.</div>}
                {srtResult?.path && (
                  <div className="export-inline-hint export-srt-saved">
                    SRT saved: <span title={srtResult.path}>{srtResult.path}</span>
                    <button type="button" onClick={() => srtResult.path && void window.api.export.openOutput(srtResult.path)}>Open folder</button>
                  </div>
                )}
                {srtResult?.error && <div className="voiceover-recorder-error">SRT not saved: {srtResult.error}</div>}
              </div>
            </div>
            <div className="export-modal-footer">
              <span className="export-footer-stats">▦&nbsp; Duration: {formatDuration(durationSeconds)} <i /> Size: about {estimatedSizeMB < 1 ? '< 1' : Math.round(estimatedSizeMB)} MB</span>
              <div className="export-footer-actions"><button className="export-cancel-button" onClick={closeDialog}>Cancel</button><button className="export-primary-button" disabled={exportDisabled} onClick={() => void handleExport()}>Export</button></div>
            </div>
          </>
        )}

        {phase === 'exporting' && (
          <div className="export-progress-view">
            <div className="export-progress-main"><ExportPreview src={previewUrl} /><ExportSummary name={exportName} duration={durationSeconds} size={estimatedSizeMB} resolution={RESOLUTION_LABELS[options.resolution]} bitrate={BITRATE_LABELS[options.bitratePreset]} codec={CODEC_LABELS[options.codec]} frameRate={options.frameRate} /></div>
            <div className="export-progress-bottom">
              <div className="export-progress-line"><span>{percent.toFixed(1)}%</span><span>{progress?.message || 'Rendering video…'}</span></div>
              <div className="export-progress-bar-track"><div className="export-progress-bar-fill" style={{ width: `${percent}%` }} /></div>
              <div className="export-progress-footer"><span>Please keep the app open until export finishes.</span><button className="export-cancel-button" onClick={cancelExport}>Cancel</button></div>
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="export-success-view">
            <div className="export-success-layout">
              <aside className="export-success-previews">
                <div className="export-version-title"><span className="export-radio-active" /> Original <small>{brandPreset.defaultAspectRatio}</small></div>
                <ExportPreview src={previewUrl} />
                <div className="export-version-title export-version-muted"><span /> 9:16 (TikTok video size) <em>Pro</em></div>
                <ExportPreview src={previewUrl} portrait />
              </aside>
              <section className="export-share-card">
                <h2>Video is saved. You can share it now.</h2>
                <div className="export-share-tabs"><button className={shareTarget === 'tiktok' ? 'active' : ''} onClick={() => setShareTarget('tiktok')}>♪ TikTok</button><button className={shareTarget === 'youtube' ? 'active' : ''} onClick={() => setShareTarget('youtube')}>▶ YouTube</button></div>
                <label>Account<button type="button" className="export-sign-in" onClick={openShareSite}>Sign in</button></label>
                <label>Name<textarea value={exportName} readOnly /></label>
                <label>Visibility<select value={visibility} onChange={(e) => setVisibility(e.target.value)}><option>Private</option><option>Public</option><option>Unlisted</option></select></label>
                <div className="export-share-checks"><span>Allow</span><label><input type="checkbox" /> Comment</label><label><input type="checkbox" /> Duet</label><label><input type="checkbox" /> Stitch</label></div>
                <div className="export-copyright-row"><span>Check copyright</span><span className="export-toggle" /></div>
                <p className="export-result-path" title={progress?.outputPath}>{progress?.outputPath}</p>
                {srtResult?.path && <p className="export-result-path" title={srtResult.path}>SRT: {srtResult.path}</p>}
              </section>
            </div>
            <div className="export-modal-footer"><button className="export-open-folder" disabled={!progress?.outputPath} onClick={() => progress?.outputPath && void window.api.export.openOutput(progress.outputPath)}>▰ Open folder</button><div className="export-footer-actions"><button className="export-cancel-button" onClick={resetToForm}>Export again</button><button className="export-primary-button" onClick={openShareSite}>Open {shareTarget === 'tiktok' ? 'TikTok' : 'YouTube'}</button><button className="export-cancel-button" onClick={closeDialog}>Done</button></div></div>
          </div>
        )}

        {(phase === 'error' || phase === 'canceled') && <div className="export-result-view"><h2>{phase === 'canceled' ? 'Export canceled' : 'Export failed'}</h2>{progress?.message && <p className="export-result-error">{progress.message}</p>}<div className="export-modal-footer"><button className="export-cancel-button" onClick={closeDialog}>Close</button><button className="export-primary-button" onClick={resetToForm}>Try again</button></div></div>}
      </div>
    </div>
  )
}
