import { useEffect, useMemo, useState } from 'react'
import type { DetectSpeakersProgress } from '@shared/transcription'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useAiDubber } from './AiDubberContext'
import { DetectGenderReviewModal } from './DetectGenderReviewModal'
import { CustomVoiceReference } from './CustomVoiceReference'
import { useSavedVoices, savedVoiceToModel } from './useSavedVoices'
import { isSavedVoiceId, savedVoiceId } from './savedVoices'
import { VOICE_MODELS, type VoiceModel } from './voiceModels'
import { parseStoredVoxCpmSettings, serializeVoxCpmSettings, getVoxCpmSettingsStorageKey, type DubbingEngine } from './voxcpmSettings'

type FilterTab = 'all' | 'male' | 'female' | 'khmer' | 'custom'

function matchesFilter(voice: VoiceModel, filter: FilterTab): boolean {
  if (filter === 'all') return true
  if (filter === 'male') return voice.gender === 'male'
  if (filter === 'female') return voice.gender === 'female'
  if (filter === 'khmer') return voice.category === 'khmer'
  return voice.category === 'custom'
}

/** Right panel while AI Dubber is active -- replaces the AI Suggestions
 * panel entirely (App.tsx's RightSidebar). */
export function VoiceModelPanel(): JSX.Element {
  const aiDubber = useAiDubber()
  const { items } = useMedia()
  const { selectedModelId, language } = useTranscript()
  const [filter, setFilter] = useState<FilterTab>('all')
  const [search, setSearch] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [autoStatus, setAutoStatus] = useState<string | null>(null)
  const [speakerJobId, setSpeakerJobId] = useState<string | null>(null)
  const [speakerProgress, setSpeakerProgress] = useState<DetectSpeakersProgress | null>(null)
  const [speakerError, setSpeakerError] = useState<string | null>(null)
  const [autoSrtOpen, setAutoSrtOpen] = useState(false)
  // Read once on mount and written straight back on change -- same
  // localStorage-backed per-machine preference the Settings panel edits.
  const [engine, setEngineState] = useState<DubbingEngine>(
    () => parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey())).engine
  )

  const setEngine = (next: DubbingEngine): void => {
    setEngineState(next)
    if (typeof localStorage === 'undefined') return
    try {
      const current = parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey()))
      localStorage.setItem(getVoxCpmSettingsStorageKey(), serializeVoxCpmSettings({ ...current, engine: next }))
    } catch {
      // Storage unavailable/full -- the in-memory choice still applies for this session.
    }
  }

  const selectedSegmentState = aiDubber.selectedSubtitleId ? aiDubber.getSegmentState(aiDubber.selectedSubtitleId) : undefined
  const generatedCount = aiDubber.segments.filter((s) => aiDubber.getSegmentState(s.id).status === 'generated').length
  const needsReviewCount = aiDubber.segments.filter((s) => aiDubber.getSegmentState(s.id).status === 'needs-review').length
  // Any line whose voice is a recording (My Voice / Custom Voice) -- Edge
  // TTS speaks those with its built-in voices instead, and says so below.
  const hasRecordedVoiceLines = aiDubber.segments.some((s) => {
    const v = aiDubber.getSegmentState(s.id).voiceId
    return v === 'custom-voice' || (v ? isSavedVoiceId(v) : false)
  })
  const anyGenerated = generatedCount > 0
  const anyGenerating = aiDubber.segments.some((s) => aiDubber.getSegmentState(s.id).status === 'generating')
  const detectionVideoId = aiDubber.pendingVideoId ?? aiDubber.state.videoMediaId
  const detectionVideo = detectionVideoId ? items.find((item) => item.id === detectionVideoId) : undefined

  useEffect(() => window.api.transcription.onDetectSpeakersProgress((progress) => {
    if (progress.jobId === speakerJobId) setSpeakerProgress(progress)
  }), [speakerJobId])

  const detectSpeakers = async (): Promise<void> => {
    if (!detectionVideo?.originalPath) return
    const jobId = `ai-dubber-gemini-speakers-${Date.now()}`
    setSpeakerJobId(jobId)
    setSpeakerError(null)
    setSpeakerProgress({ jobId, stage: 'extracting-audio', percent: 0, message: 'Preparing Gemini Auto SRT…' })
    try {
      const result = await window.api.transcription.detectSpeakers({
        jobId,
        mediaId: detectionVideo.id,
        originalPath: detectionVideo.originalPath,
        modelId: selectedModelId,
        language
      })
      const prepared = aiDubber.prepareDetectedWorkspace({ videoMediaId: detectionVideo.id, result })
      if (prepared.segmentCount === 0) setSpeakerError('Gemini did not detect any spoken dialogue in this video.')
      else setAutoSrtOpen(false)
    } catch (caught) {
      const rawMessage = caught instanceof Error ? caught.message : 'Gemini speaker detection failed.'
      // Electron prefixes rejected IPC calls with an implementation detail
      // ("Error invoking remote method …"). The panel should show the useful
      // Gemini reason only, not that noisy bridge wrapper.
      setSpeakerError(rawMessage.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, ''))
    } finally {
      setSpeakerJobId(null)
    }
  }

  // The user's own recorded voices sit in the same grid as the catalog ones
  // -- a saved voice is just another voice to assign, so it belongs where
  // the user already goes to pick one, not only in the Custom Voice section
  // that happened to create it.
  const savedVoices = useSavedVoices()
  const visibleVoices = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = [...VOICE_MODELS, ...savedVoices.map((v) => savedVoiceToModel(v, savedVoiceId(v.id)))]
    return all.filter((v) => matchesFilter(v, filter) && (!term || v.name.toLowerCase().includes(term) || v.description.toLowerCase().includes(term)))
  }, [filter, search, savedVoices])

  return (
    <aside className="panel panel-brand ai-dubber-voice-panel">
      <div className="panel-fixed-head">
        <div className="ai-dubber-voice-header">
          <h3>Voice Model</h3>

          {/* Which engine actually speaks the lines, inline between the
              title and Detect Gender rather than its own row below --
              three related controls for "who's about to talk" read as one
              header line instead of two stacked ones. Persisted per
              machine, so it stays put between sessions. The AI/speed
              tradeoff each option used to spell out underneath its name
              doesn't fit on one line here; it's still one hover away via
              each button's own title. */}
          <div className="ai-dubber-engine-switch" role="group" aria-label="Voice engine">
            <button
              className={engine === 'voxcpm2' ? 'ai-dubber-engine-option ai-dubber-engine-option-active' : 'ai-dubber-engine-option'}
              title="Local AI model. Any voice style, can clone a reference recording, but slower (loads a model first) and needs the portable install."
              onClick={() => setEngine('voxcpm2')}
            >
              VoxCPM2
            </button>
            <button
              className={engine === 'edge-tts' ? 'ai-dubber-engine-option ai-dubber-engine-option-active' : 'ai-dubber-engine-option'}
              title="Microsoft Edge neural TTS, built into this app -- nothing to install. Real Khmer male/female voices, about a second per line, but it needs internet and only offers those fixed voices (no cloning)."
              onClick={() => setEngine('edge-tts')}
            >
              Edge TTS
            </button>
          </div>

          <button
            className="header-generate-button ai-dubber-detect-button"
            onClick={() => setReviewOpen(true)}
            disabled={!aiDubber.state.videoMediaId || aiDubber.segments.length === 0}
          >
            Detect Gender
          </button>

        </div>

        <div className="panel-tabs ai-dubber-voice-tabs">
          {(['all', 'male', 'female', 'khmer'] as FilterTab[]).map((tab) => (
            <button key={tab} className={filter === tab ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setFilter(tab)}>
              {tab === 'all' ? 'All' : tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
          <button className={filter === 'custom' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setFilter('custom')}>Custom</button>
          <button
            className={`ai-dubber-auto-srt-button${autoSrtOpen ? ' ai-dubber-auto-srt-button-open' : ''}`}
            onClick={() => setAutoSrtOpen((open) => !open)}
            title="Open Gemini Auto SRT and speaker detection"
            aria-expanded={autoSrtOpen}
          >
            {speakerJobId ? `${Math.round(speakerProgress?.percent ?? 0)}%` : 'Auto SRT'}
          </button>
        </div>
        {autoSrtOpen && (
          <div className="ai-dubber-auto-srt-popover" role="dialog" aria-label="Auto SRT and speaker detection">
            <div className="ai-dubber-auto-srt-popover-head">
              <span className="ai-dubber-auto-srt-popover-icon" aria-hidden="true">✦</span>
              <div className="ai-dubber-auto-srt-popover-title">
                <strong>Auto SRT</strong>
                <small>Speaker Detection · Gemini API</small>
              </div>
              <button aria-label="Close Auto SRT" onClick={() => setAutoSrtOpen(false)}>×</button>
            </div>
            <div className="ai-dubber-auto-srt-features" aria-label="Detection features">
              <span>Precise timestamps</span>
              <span>Match speakers</span>
            </div>
            <div className="ai-dubber-auto-srt-video">
              <span className={`ai-dubber-auto-srt-video-status${detectionVideo?.readyToUse ? ' ready' : ''}`} />
              <div>
                <small>Selected video</small>
                <strong>{detectionVideo?.fileName ?? 'No video selected'}</strong>
              </div>
            </div>
            <button
              className="ai-dubber-auto-srt-generate"
              disabled={!detectionVideo?.readyToUse || Boolean(speakerJobId)}
              onClick={() => void detectSpeakers()}
            >
              {speakerJobId ? 'Detecting speakers…' : 'Detect Speakers & Generate SRT'}
            </button>
            {!detectionVideo && <small className="ai-dubber-auto-srt-hint">Add a video from the Subtitle &amp; Script panel first.</small>}
            {speakerProgress && speakerJobId && (
              <div className="ai-dubber-auto-srt-progress">
                <span>{speakerProgress.message}</span>
                <span className="ai-dubber-speaker-progress-track"><span style={{ width: `${speakerProgress.percent}%` }} /></span>
                <button onClick={() => void window.api.transcription.cancelDetectSpeakers(speakerJobId)}>Cancel</button>
              </div>
            )}
            {speakerError && <div className="voiceover-recorder-error ai-dubber-auto-srt-error">{speakerError}</div>}
          </div>
        )}
        <input className="ai-dubber-voice-search" type="text" placeholder="Search voice model…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="panel-scroll-body editor-scroll">
        {/* Each card: click it to put that voice on the SELECTED subtitle --
            or, with no subtitle selected, on every subtitle. Its "All" pill
            always does every subtitle regardless of selection. Replaces a
            sticky "Apply to ALL" checkbox above the grid, a hidden global
            mode that silently changed what every click did. A card is never
            disabled: an earlier version greyed every card out until a row
            was selected, which just read as the whole panel being broken. */}
        <div className="ai-dubber-voice-grid">
          {visibleVoices.map((voice) => {
            const selected = selectedSegmentState?.voiceId === voice.id
            const hasSelection = !!aiDubber.selectedSubtitleId
            // With speakers detected (Auto SRT), a voice belongs to a
            // CHARACTER: picking one for a selected line gives it to every
            // line that speaker says. Setting only the one line left all of
            // that speaker's other lines on the default voice.
            const selectedSpeakerId = selectedSegmentState?.speakerId ?? aiDubber.segments.find((segment) => segment.id === aiDubber.selectedSubtitleId)?.speakerId
            const selectedSpeaker = selectedSpeakerId ? aiDubber.state.speakers[selectedSpeakerId] : undefined
            return (
              <div key={voice.id} className={`ai-dubber-voice-card${selected ? ' ai-dubber-voice-card-selected' : ''}`}>
                <button
                  className="ai-dubber-voice-card-main"
                  disabled={aiDubber.segments.length === 0}
                  title={
                    selectedSpeaker
                      ? `Use ${voice.name} for every line of ${selectedSpeaker.name} (${selectedSpeaker.segmentIds.length})`
                      : hasSelection
                        ? `Use ${voice.name} for the selected subtitle`
                        : `No subtitle selected -- use ${voice.name} for all ${aiDubber.segments.length} subtitles`
                  }
                  onClick={() => {
                    if (selectedSpeaker && selectedSpeakerId) aiDubber.setSpeakerVoice(selectedSpeakerId, voice.id)
                    else if (aiDubber.selectedSubtitleId) aiDubber.setSegmentVoice(aiDubber.selectedSubtitleId, voice.id)
                    else aiDubber.setAllSegmentsVoice(voice.id)
                  }}
                >
                  <span className={`ai-dubber-voice-avatar ai-dubber-voice-avatar-${voice.gender}`}>{voice.avatarLetter}</span>
                  <span className="ai-dubber-voice-text">
                    <span className="ai-dubber-voice-name">{voice.name}</span>
                    <span className="ai-dubber-voice-description">{voice.description}</span>
                  </span>
                  {selected && <span className="ai-dubber-voice-check">✓</span>}
                </button>
                <button
                  className="ai-dubber-voice-card-all"
                  title={`Use ${voice.name} for ALL ${aiDubber.segments.length} subtitles`}
                  disabled={aiDubber.segments.length === 0}
                  onClick={() => aiDubber.setAllSegmentsVoice(voice.id)}
                >
                  All
                </button>
              </div>
            )
          })}
        </div>

        {visibleVoices.some((v) => v.id === 'custom-voice') && <CustomVoiceReference />}
      </div>

      <div className="panel-fixed-foot">
        {/* Real counts, replacing an "Output Settings" block whose Language
            and Voice Speed dropdowns were inert -- no state, no onChange,
            nothing read them, and Language offered only Khmer. Per-line
            speed lives on each subtitle row's own ⚙ settings. */}
        <div className="ai-dubber-generate-summary">
          <span>{aiDubber.segments.length} subtitles</span>
          {generatedCount > 0 && <span className="ai-dubber-generate-summary-done">{generatedCount} ready</span>}
          {needsReviewCount > 0 && <span className="ai-dubber-generate-summary-failed">{needsReviewCount} failed</span>}
        </div>
        {/* Names the engine the next run will actually use, so a mismatch
            between what's selected above and what runs is visible before
            pressing Generate rather than guessed at afterwards. */}
        <div className="ai-dubber-generate-engine">Using {engine === 'edge-tts' ? 'Edge TTS' : 'VoxCPM2'}</div>
        {engine === 'edge-tts' && hasRecordedVoiceLines && (
          <div className="ai-dubber-generate-note">Edge TTS can't clone a recording -- lines set to My Voice / Custom Voice are spoken by its built-in Khmer male or female voice.</div>
        )}

        {/* Post-generation fixes, for when the dub and the SRT have drifted
            apart: Auto-Speed compresses any line that outgrew its slot and
            then re-aligns; Auto-Sync just re-aligns. Both no-op quietly when
            nothing needs fixing. */}
        <div className="ai-dubber-auto-row">
          <button
            className="ai-dubber-auto-button ai-dubber-auto-button-sync"
            title="Put every dubbed line back on its subtitle's exact start time"
            disabled={generatedCount === 0 || aiDubber.autoSpeedRunning}
            onClick={() => setAutoStatus(`Auto-Sync: ${aiDubber.autoSyncDubClips()} line(s) re-aligned`)}
          >
            ⟲ Auto-Sync
          </button>
          <button
            className="ai-dubber-auto-button ai-dubber-auto-button-speed"
            title="Speed up any line that runs past the next subtitle so it fits, then re-align"
            disabled={generatedCount === 0 || aiDubber.autoSpeedRunning}
            onClick={() => {
              setAutoStatus('Auto-Speed: re-rendering…')
              void aiDubber.autoSpeedDubClips().then((n) => setAutoStatus(`Auto-Speed: ${n} line(s) re-fitted`))
            }}
          >
            {aiDubber.autoSpeedRunning ? '… Working' : '⚡ Auto-Speed'}
          </button>
        </div>
        {autoStatus && <div className="ai-dubber-auto-status">{autoStatus}</div>}

        <div className="ai-dubber-generate-row">
          <button className="ai-dubber-generate-button" onClick={() => aiDubber.generateDubbing()} disabled={!aiDubber.state.videoMediaId || anyGenerating}>
            {anyGenerating && aiDubber.state.generationProgress
              ? `Generating ${aiDubber.state.generationProgress.completed} / ${aiDubber.state.generationProgress.total}…`
              : anyGenerating
                ? 'Generating…'
                : 'Generate Dubbing'}
          </button>
          {anyGenerating && aiDubber.state.generationProgress ? (
            // Stop a long run part-way: finished lines stay on the Timeline.
            <button className="ai-dubber-cancel-button" title="Stop generating — lines already made are kept" onClick={() => aiDubber.cancelGeneration()}>
              Cancel
            </button>
          ) : (
            <button className="ai-dubber-download-button" disabled={!anyGenerated} title={anyGenerated ? 'Export dubbed audio' : 'Available once dubbing is generated'}>
              ⬇
            </button>
          )}
        </div>
        {aiDubber.state.generationError && (
          <div className="voiceover-recorder-error ai-dubber-generation-message">
            <span>{aiDubber.state.generationError}</span>
            <button type="button" title="Close" aria-label="Close message" onClick={() => aiDubber.dismissGenerationMessage('error')}>×</button>
          </div>
        )}
        {aiDubber.state.generationNote && (
          <div className="ai-dubber-generation-note ai-dubber-generation-message">
            <span>{aiDubber.state.generationNote}</span>
            <button type="button" title="Close" aria-label="Close message" onClick={() => aiDubber.dismissGenerationMessage('note')}>×</button>
          </div>
        )}
      </div>

      {reviewOpen && (
        <DetectGenderReviewModal
          initialIndex={Math.max(0, aiDubber.segments.findIndex((segment) => segment.id === aiDubber.selectedSubtitleId))}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </aside>
  )
}
