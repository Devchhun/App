import { useEffect, useMemo, useState } from 'react'
import { useAiDubber } from './AiDubberContext'
import { DetectGenderReviewModal } from './DetectGenderReviewModal'
import { AutoSrtPanel } from './AutoSrtPanel'
import { DEFAULT_VOICE_TEST_TEXT, useVoicePreview } from './useVoicePreview'
import { CustomVoiceReference } from './CustomVoiceReference'
import { useSavedVoices, savedVoiceToModel } from './useSavedVoices'
import { BUILTIN_NARRATORS, isSavedVoiceId, savedVoiceId, loadStoryNarratorVoiceId, storeStoryNarratorVoiceId, subscribeStoryNarrator } from './savedVoices'
import { VOICE_MODELS, type VoiceModel } from './voiceModels'
import { parseStoredVoxCpmSettings, serializeVoxCpmSettings, getVoxCpmSettingsStorageKey, type DubbingEngine } from './voxcpmSettings'
import { useKiriVoices, kiriVoiceToModel } from './useKiriVoices'
import { KiriCloneDialog } from './KiriCloneDialog'
import { EDGE_VOICE_CARDS, ENGINE_LABEL } from './engineVoices'


type FilterTab = 'all' | 'drama' | 'male' | 'female' | 'khmer' | 'custom'

function matchesFilter(voice: VoiceModel, filter: FilterTab): boolean {
  if (filter === 'all') return true
  if (filter === 'male') return voice.gender === 'male'
  if (filter === 'female') return voice.gender === 'female'
  if (filter === 'khmer') return voice.category === 'khmer'
  if (filter === 'drama') return voice.category === 'drama'
  return voice.category === 'custom'
}

/** Which Edge voice a line would be spoken with -- a card lights up for
 * every line that sounds like it, whatever catalog voice the line holds. */
function edgeVoiceOf(voiceId: string | undefined): string | undefined {
  return voiceId ? VOICE_MODELS.find((v) => v.id === voiceId)?.edgeVoice : undefined
}

/** Right panel while AI Dubber is active -- replaces the AI Suggestions
 * panel entirely (App.tsx's RightSidebar). */
export function VoiceModelPanel(): JSX.Element {
  const aiDubber = useAiDubber()
  const [filter, setFilter] = useState<FilterTab>('all')
  const [search, setSearch] = useState('')
  // Search is an icon at the end of the Test row; it turns the row into the
  // search field until closed (closing clears it).
  const [searchOpen, setSearchOpen] = useState(false)
  const closeSearch = (): void => {
    setSearch('')
    setSearchOpen(false)
  }
  const [reviewOpen, setReviewOpen] = useState(false)
  const [autoStatus, setAutoStatus] = useState<string | null>(null)
  const [autoSrtOpen, setAutoSrtOpen] = useState(false)
  // Read once on mount and written straight back on change -- same
  // localStorage-backed per-machine preference the Settings panel edits.
  const [engine, setEngineState] = useState<DubbingEngine>(
    () => parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey())).engine
  )

  const [steadyPace, setSteadyPaceState] = useState<boolean>(
    () => parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey())).steadyPace
  )
  const [kiriActing, setKiriActingState] = useState<boolean>(
    () => parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey())).kiriActing
  )
  const setKiriActing = (next: boolean): void => {
    setKiriActingState(next)
    try {
      const current = parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey()))
      localStorage.setItem(getVoxCpmSettingsStorageKey(), serializeVoxCpmSettings({ ...current, kiriActing: next }))
    } catch {
      // Storage unavailable -- the choice still applies for this session.
    }
  }
  const setSteadyPace = (next: boolean): void => {
    setSteadyPaceState(next)
    try {
      const current = parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey()))
      localStorage.setItem(getVoxCpmSettingsStorageKey(), serializeVoxCpmSettings({ ...current, steadyPace: next }))
    } catch {
      // Storage unavailable -- the choice still applies for this session.
    }
  }

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


  // The user's own recorded voices sit in the same grid as the catalog ones
  // -- a saved voice is just another voice to assign, so it belongs where
  // the user already goes to pick one, not only in the Custom Voice section
  // that happened to create it.
  const savedVoices = useSavedVoices()
  // Voice test: a line (typed, or the default) spoken in one voice, through
  // the real dubbing pipeline, then played.
  const [testText, setTestText] = useState('')
  const voicePreview = useVoicePreview({
    customVoiceReferenceAudioPath: aiDubber.state.customVoiceReferenceAudioPath,
    customVoiceReferenceText: aiDubber.state.customVoiceReferenceText
  })
  const testing = voicePreview.preview
  // KiriTTS: the account's own voices -- built-in Khmer ones and its clones.
  const kiri = useKiriVoices(engine === 'kiritts')
  const [narratorId, setNarratorId] = useState<string | null>(() => loadStoryNarratorVoiceId())
  useEffect(() => subscribeStoryNarrator(setNarratorId), [])
  // Cloning (new voices, VoxCPM2 copies, the account's clones) lives in its
  // own dialog -- the panel keeps just the button.
  const [cloneOpen, setCloneOpen] = useState(false)
  const kiriClones = kiri.state.status === 'ready' ? kiri.state.voices.filter((v) => v.cloned).length : 0
  const visibleVoices = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all =
      engine === 'kiritts'
        ? kiri.state.status === 'ready'
          ? kiri.state.voices.map(kiriVoiceToModel)
          : []
        : engine === 'edge-tts'
          ? EDGE_VOICE_CARDS
          : [...VOICE_MODELS, ...savedVoices.map((v) => savedVoiceToModel(v, savedVoiceId(v.id)))]
    return all.filter((v) => matchesFilter(v, filter) && (!term || v.name.toLowerCase().includes(term) || v.description.toLowerCase().includes(term)))
  }, [filter, search, savedVoices, engine, kiri.state])

  // Edge cannot clone a voice, and has only its two own voices: its mode
  // has no Custom or Drama tab to be left on. KiriTTS has no Drama catalog.
  useEffect(() => {
    if (engine === 'edge-tts' && (filter === 'custom' || filter === 'drama')) setFilter('all')
    if (engine === 'kiritts' && filter === 'drama') setFilter('all')
  }, [engine, filter])

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
            <button
              className={engine === 'kiritts' ? 'ai-dubber-engine-option ai-dubber-engine-option-active' : 'ai-dubber-engine-option'}
              title="KiriTTS in the cloud: Khmer voices and voice cloning with nothing running on this computer. Needs a KiriTTS API key (Settings > AI API Keys) on a plan with API access."
              onClick={() => setEngine('kiritts')}
            >
              KiriTTS
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
          {((engine === 'edge-tts' ? ['all', 'male', 'female', 'khmer'] : engine === 'kiritts' ? ['all', 'male', 'female'] : ['all', 'drama', 'male', 'female', 'khmer']) as FilterTab[]).map((tab) => (
            <button key={tab} className={filter === tab ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setFilter(tab)}>
              {tab === 'all' ? 'All' : tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
          {engine !== 'edge-tts' && (
            <button className={filter === 'custom' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setFilter('custom')}>{engine === 'kiritts' ? 'Cloned' : 'Custom'}</button>
          )}
          <button
            className={`ai-dubber-auto-srt-button${autoSrtOpen ? ' ai-dubber-auto-srt-button-open' : ''}`}
            onClick={() => setAutoSrtOpen((open) => !open)}
            title="Open Gemini Auto SRT and speaker detection"
            aria-expanded={autoSrtOpen}
          >
            {aiDubber.batchJob ? `${Math.round(aiDubber.batchJob.percent)}%` : 'Auto SRT'}
          </button>
        </div>
        {/* Auto SRT is its own panel over the app (AutoSrtPanel.tsx):
            Batch Load + one-video-at-a-time transcription. */}
        {autoSrtOpen && <AutoSrtPanel onClose={() => setAutoSrtOpen(false)} />}
        {/* Voice test: press a voice's round icon to hear this line in it.
            The search icon at its end swaps the row for a search field. */}
        <div className={`ai-dubber-voice-test${searchOpen ? ' ai-dubber-voice-test-searching' : ''}`}>
          {searchOpen ? (
            <>
              <span className="ai-dubber-voice-test-label ai-dubber-voice-search-label" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                type="text"
                autoFocus
                value={search}
                placeholder="Search voices…"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') closeSearch()
                }}
              />
              <button className="ai-dubber-voice-search-toggle" title="Close search" aria-label="Close search" onClick={closeSearch}>
                ✕
              </button>
            </>
          ) : (
            <>
              <span className="ai-dubber-voice-test-label">▶ Test</span>
              <input
                type="text"
                value={testText}
                placeholder={DEFAULT_VOICE_TEST_TEXT}
                title="Type a line, then press a voice's round icon to hear it in that voice"
                onChange={(e) => setTestText(e.target.value)}
              />
              <button className="ai-dubber-voice-search-toggle" title="Search voices" aria-label="Search voices" onClick={() => setSearchOpen(true)}>
                <SearchIcon />
              </button>
            </>
          )}
        </div>
        {testing && testing.status !== 'playing' && (
          <div className={`ai-dubber-voice-test-status${testing.status === 'error' ? ' ai-dubber-voice-test-error' : ''}`}>
            {testing.status === 'generating'
              ? `Making the test in ${visibleVoices.find((v) => v.id === testing.voiceId)?.name ?? 'this voice'}…${engine === 'voxcpm2' ? ' (VoxCPM2 loads its model first — up to a minute; Edge TTS takes a few seconds)' : ''}`
              : testing.error}
            <button aria-label="Close" onClick={voicePreview.stop}>
              ×
            </button>
          </div>
        )}
      </div>

      <div className="panel-scroll-body editor-scroll">
        {engine === 'kiritts' && (
          <div className="ai-dubber-kiri-box">
            {kiri.state.status === 'no-key' && <div className="ai-dubber-kiri-note">Add your KiriTTS API key in Settings &gt; AI API Keys to use its voices.</div>}
            {kiri.state.status === 'loading' && <div className="ai-dubber-kiri-note">Loading your KiriTTS voices…</div>}
            {kiri.state.status === 'error' && (
              <div className="ai-dubber-kiri-note ai-dubber-kiri-error">
                {kiri.state.error}{' '}
                <button className="ai-dubber-kiri-link" onClick={kiri.refresh}>
                  Retry
                </button>
              </div>
            )}
            {kiri.state.status === 'ready' && (
              <div className="ai-dubber-kiri-toolbar">
                <button className="ai-dubber-kiri-clone-open" onClick={() => setCloneOpen(true)} title="Clone a new voice from a recording or video, copy a VoxCPM2 voice, see your clones">
                  🎙 Clone a voice
                </button>
                <span className="ai-dubber-kiri-count">{kiriClones} cloned</span>
                <button className="ai-dubber-kiri-link" onClick={kiri.refresh} title="Reload the voice list">
                  ⟳
                </button>
              </div>
            )}
          </div>
        )}
        {cloneOpen && <KiriCloneDialog voices={kiri.state.status === 'ready' ? kiri.state.voices : []} onChanged={kiri.refresh} onClose={() => setCloneOpen(false)} />}
        {/* Each card: click it to put that voice on the SELECTED subtitle --
            or, with no subtitle selected, on every subtitle. Its "All" pill
            always does every subtitle regardless of selection. Replaces a
            sticky "Apply to ALL" checkbox above the grid, a hidden global
            mode that silently changed what every click did. A card is never
            disabled: an earlier version greyed every card out until a row
            was selected, which just read as the whole panel being broken. */}
        <div className="ai-dubber-voice-grid">
          {visibleVoices.map((voice) => {
            const sameVoice = (voiceId: string | undefined): boolean =>
              engine === 'edge-tts' ? !!voiceId && edgeVoiceOf(voiceId) === voice.edgeVoice : voiceId === voice.id
            // No line selected: lit when EVERY line has this voice (what
            // its click just did), so choosing one visibly took.
            const selected = selectedSegmentState
              ? sameVoice(selectedSegmentState.voiceId)
              : aiDubber.segments.length > 0 && aiDubber.segments.every((segment) => sameVoice(aiDubber.getSegmentState(segment.id).voiceId))
            const hasSelection = !!aiDubber.selectedSubtitleId
            // With speakers detected (Auto SRT), a voice belongs to a
            // CHARACTER: picking one for a selected line gives it to every
            // line that speaker says. Setting only the one line left all of
            // that speaker's other lines on the default voice.
            const selectedSpeakerId = selectedSegmentState?.speakerId ?? aiDubber.segments.find((segment) => segment.id === aiDubber.selectedSubtitleId)?.speakerId
            const selectedSpeaker = selectedSpeakerId ? aiDubber.state.speakers[selectedSpeakerId] : undefined
            return (
              <div key={voice.id} className={`ai-dubber-voice-card${selected ? ' ai-dubber-voice-card-selected' : ''}`}>
                {/* The voice's round icon is its test button: hover shows ▶,
                    it makes and plays the test line; ■ stops it. */}
                <button
                  className={`ai-dubber-voice-avatar ai-dubber-voice-avatar-${voice.gender} ai-dubber-voice-play${testing?.voiceId === voice.id ? ` ai-dubber-voice-play-${testing.status}` : ''}`}
                  title={testing?.voiceId === voice.id && testing.status !== 'error' ? 'Stop' : `Test: hear ${voice.name}`}
                  aria-label={`Test ${voice.name}`}
                  onClick={() => {
                    if (testing?.voiceId === voice.id && testing.status !== 'error') voicePreview.stop()
                    else voicePreview.play(voice, testText, engine)
                  }}
                >
                  <span className="ai-dubber-voice-play-letter">{voice.avatarLetter}</span>
                  <span className="ai-dubber-voice-play-icon" aria-hidden="true">
                    {testing?.voiceId === voice.id ? (testing.status === 'generating' ? '…' : testing.status === 'playing' ? '■' : '▶') : '▶'}
                  </span>
                </button>
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
                  <span className="ai-dubber-voice-text">
                    <span className="ai-dubber-voice-name">{voice.name}</span>
                    <span className="ai-dubber-voice-description">{voice.description}</span>
                  </span>
                  {selected && <span className="ai-dubber-voice-check">✓</span>}
                </button>
                {engine === 'kiritts' && (
                  <button
                    className={`ai-dubber-voice-card-narrator${narratorId === voice.id ? ' ai-dubber-voice-card-narrator-on' : ''}`}
                    title={narratorId === voice.id ? `${voice.name} narrates Recap (សម្រាយរឿង) -- click to unset` : `Use ${voice.name} to narrate Recap (សម្រាយរឿង)`}
                    onClick={() => storeStoryNarratorVoiceId(narratorId === voice.id ? null : voice.id)}
                  >
                    ★
                  </button>
                )}
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
        <div className="ai-dubber-generate-engine">Using {ENGINE_LABEL[engine]}</div>
        <label
          className="ai-dubber-steady-pace"
          title="On: every line is spoken at the voice's own normal speed -- never sped up to fit its subtitle, never slower or faster because of its emotion. A line that runs long starts the next one a little later; 🎬 Video Sync slows the picture there to make room. Off: long lines are sped up to fit (up to 1.28x)."
        >
          <input type="checkbox" checked={steadyPace} onChange={(e) => setSteadyPace(e.target.checked)} />
          Steady voice speed
        </label>
        {engine === 'kiritts' && (
          <label
            className="ai-dubber-steady-pace"
            title="On: each line's emotion is sent to KiriTTS (e.g. 'very angry, hard, forceful'). Off: the voice speaks plainly -- on cloned voices this fails far less often (no babble or tails) and often sounds better."
          >
            <input type="checkbox" checked={kiriActing} onChange={(e) => setKiriActing(e.target.checked)} />
            Send emotions to KiriTTS
          </label>
        )}
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
            title="Put every dubbed line back on its subtitle's start time -- never over the line before it"
            disabled={generatedCount === 0 || aiDubber.autoSpeedRunning}
            onClick={() => setAutoStatus(`Auto-Sync: ${aiDubber.autoSyncDubClips()} line(s) re-aligned`)}
          >
            ⟲ Auto-Sync
          </button>
          <button
            className="ai-dubber-auto-button ai-dubber-auto-button-speed"
            title="Speed up lines that run past the next subtitle -- at most 1.25x so the voice stays clear -- then re-align; a line still too long runs a little late"
            disabled={generatedCount === 0 || aiDubber.autoSpeedRunning}
            onClick={() => {
              setAutoStatus('Auto-Speed: re-rendering…')
              void aiDubber.autoSpeedDubClips().then((n) => setAutoStatus(`Auto-Speed: ${n} line(s) re-fitted`))
            }}
          >
            {aiDubber.autoSpeedRunning ? '… Working' : '⚡ Auto-Speed'}
          </button>
          <button
            className="ai-dubber-auto-button ai-dubber-auto-button-video"
            title="For lines still longer than their room: play the video a little slower under that line (never below 0.85x) instead of speeding the voice up -- everything after moves later, subtitles included. Ctrl+Z undoes it."
            disabled={generatedCount === 0 || aiDubber.autoSpeedRunning}
            onClick={() => {
              const { lines, addedSeconds, stillLong } = aiDubber.videoSyncDubClips()
              const late = stillLong > 0 ? ` · ${stillLong} line(s) at the 0.85x limit still run a little late` : ''
              setAutoStatus(lines === 0 ? (stillLong > 0 ? `Video Sync: nothing more to slow${late}` : 'Video Sync: every line already fits') : `Video Sync: video slowed under ${lines} line(s), +${addedSeconds.toFixed(1)} s${late}`)
            }}
          >
            🎬 Video Sync
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

function SearchIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.4 10.4 14 14" />
    </svg>
  )
}
