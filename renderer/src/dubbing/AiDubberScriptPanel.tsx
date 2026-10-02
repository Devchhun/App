import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMedia } from '../media/MediaContext'
import { usePlaybackTime, usePlaybackControls } from '../playback/PlaybackContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useAiDubber, srtPlacementMessage } from './AiDubberContext'
import { VOICE_MODELS } from './voiceModels'
import { loadSavedVoices, savedVoiceId } from './savedVoices'
import { EmotionChip, LineDebugView, LinePerformanceEditor } from './LinePerformanceEditor'
import { EpisodeBar, EpisodeList } from './EpisodePanel'
import { SubtitleOverlayPanel } from './SubtitleOverlayPanel'
import { CloudConsentModal } from '../suggestions/CloudConsentModal'
import { useConfirm } from '../ui/ConfirmDialog'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'
import { defaultDubbingSegmentState, type DubbingSegmentState } from '@shared/dubbing'
import { effectiveInnerVoice } from '@shared/innerVoice'

function formatSeconds(value: number): string {
  return value.toFixed(2)
}

/** Left panel while AI Dubber is active -- replaces the Media panel entirely
 * (App.tsx's LeftColumn). Two states, mirroring NarrationScriptPanel.tsx's
 * own setup-vs-segment-list split: a compact Add Video/Add SRT form (no
 * workspace prepared yet) and the editable subtitle list. */
export function AiDubberScriptPanel(): JSX.Element {
  const aiDubber = useAiDubber()
  if (!aiDubber.state.videoMediaId) return <AiDubberSetup />
  return <AiDubberSubtitleEditor />
}

function AiDubberSetup(): JSX.Element {
  const aiDubber = useAiDubber()
  const [srtFileName, setSrtFileName] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const episodeCount = aiDubber.episodes.length

  // One button for everything: pick the video(s) and/or the .srt together.
  // A video goes straight onto the Timeline and opens here (with the SRT
  // picked alongside it); several videos become the episodes of a series;
  // an SRT on its own waits for the next video. A video already in Media
  // is simply picked again -- it is reused, not imported twice.
  const handleAdd = async (): Promise<void> => {
    setImporting(true)
    try {
      const result = await aiDubber.importVideos()
      if (result.srtWaiting && result.srtFileName) setSrtFileName(result.srtFileName)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="ai-dubber-setup">
      <div className="panel-fixed-head">
        <h2>AI Dubber - Subtitle &amp; Script</h2>
        {/* The one Add button sits in the header itself, where the
            instructions used to be; they are its hover title now. */}
        <button
          className="ai-dubber-setup-add-button ai-dubber-setup-header-add"
          onClick={() => void handleAdd()}
          disabled={importing}
          title="Pick your video(s) and/or its .srt together -- the video goes straight onto the Timeline. Pick every episode of a series at once for Auto SRT."
        >
          <span className="ai-dubber-setup-add-button-title">{importing ? 'Adding…' : '+ Add Video & SRT'}</span>
          <span className="ai-dubber-setup-add-button-hint">MP4, MOV, AVI… and/or .srt — one or many</span>
        </button>
      </div>

      {srtFileName && <div className="narration-setup-file-chip">{srtFileName} — used for the video you add next</div>}
      {episodeCount >= 2 && <EpisodeList />}
    </div>
  )
}

/** The open video has no subtitles yet (Add Video puts it straight on the
 * Timeline): bring an SRT in, or have Gemini Auto SRT write one. */
function NoSubtitlesYet(): JSX.Element {
  const aiDubber = useAiDubber()
  const [error, setError] = useState<string | null>(null)
  const videoMediaId = aiDubber.state.videoMediaId ?? ''
  // Auto SRT here = every video on the Timeline, one at a time (the same
  // run as the Auto SRT panel), each video's lines under it.
  const job = aiDubber.batchJob
  const running = !!job

  // Any number of SRTs: one video takes its SRT as before; with several
  // videos on the Timeline each SRT goes under its own video (by name /
  // episode number, else in order).
  const handleAddSrt = async (): Promise<void> => {
    setError(null)
    const result = await window.api.transcription.importSrtFile({ multiple: true })
    const files = result.files ?? (result.srtText ? [{ fileName: result.fileName ?? 'subtitles.srt', srtText: result.srtText }] : [])
    if (result.canceled || files.length === 0) return
    if (files.length === 1 && aiDubber.batchRows.length <= 1) {
      const prepared = aiDubber.prepareWorkspace({ videoMediaId, srtText: files[0].srtText, srtFileName: files[0].fileName })
      if (prepared.segmentCount === 0) setError('No valid subtitle segments were found in this SRT file.')
      return
    }
    const placed = aiDubber.addSrtFiles(files)
    if (placed.placed.every((p) => p.lines === 0)) setError('No valid subtitle segments were found in these SRT files.')
    else if (placed.unmatched.length > 0) setError(srtPlacementMessage(placed))
  }

  return (
    <div className="ai-dubber-empty">
      <strong>No subtitles yet</strong>
      <p>The video is on the Timeline. Add its SRT, or let Gemini Auto SRT write one — then Translate to Khmer and generate the dub.</p>
      <div className="ai-dubber-empty-actions">
        <button className="ai-dubber-episodes-primary" onClick={() => void handleAddSrt()} disabled={running}>
          Add SRT
        </button>
        {running ? (
          <button className="ai-dubber-remove-srt-button" onClick={aiDubber.cancelBatch}>
            Stop Auto SRT
          </button>
        ) : (
          <button className="ai-dubber-remove-srt-button" title="Gemini transcribes each video on the Timeline, one at a time, and tells the speakers apart" onClick={() => void aiDubber.transcribeBatch()}>
            ✦ Auto SRT (Gemini)
          </button>
        )}
      </div>
      {running && job && (
        <div className="ai-dubber-episodes-progress">
          <span>{job.message}</span>
          <span className="ai-dubber-speaker-progress-track">
            <span style={{ width: `${job.percent}%` }} />
          </span>
        </div>
      )}
      {aiDubber.batchMessage && !running && (
        <div className="ai-dubber-analysis-message">
          <span>{aiDubber.batchMessage}</span>
          <button aria-label="Dismiss" onClick={aiDubber.dismissBatchMessage}>
            ×
          </button>
        </div>
      )}
      {error && <div className="voiceover-recorder-error">{error}</div>}
    </div>
  )
}

/** Which line the playhead is in -- reported only when that changes, so
 * playback does not re-render the whole subtitle list every frame. The
 * lines are in time order: a binary search finds the last one starting at
 * or before the playhead. */
function PlayingLineTracker({ segments, onChange }: { segments: TranscriptSegment[]; onChange: (id: string | null) => void }): null {
  const { currentTime } = usePlaybackTime()
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].startTime <= currentTime) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const id = found >= 0 && currentTime < segments[found].endTime ? segments[found].id : null
  useEffect(() => onChange(id), [id, onChange])
  return null
}

interface SubtitleRowActions {
  select: (segment: TranscriptSegment) => void
  preview: (segment: TranscriptSegment) => void
  toggleExpanded: (segmentId: string) => void
  setTiming: (segmentId: string, edge: 'start' | 'end', time: number) => void
  setText: (segmentId: string, text: string) => void
  remove: (segmentId: string) => void
  setVoice: (segmentId: string, voiceId: string) => void
  setControl: (segmentId: string, field: 'pitch' | 'speed' | 'volumeDb', value: number) => void
  setInnerVoice: (segmentId: string, on: boolean) => void
}

/** One subtitle line. Memoized: with thousands of lines (a whole series in
 * one list) only the lines whose own props changed re-render. */
const SubtitleRow = memo(function SubtitleRow({
  segment,
  index,
  segState: savedState,
  speakerName,
  innerVoice,
  active,
  expanded,
  showDebug,
  voiceDescription,
  savedVoices,
  actions
}: {
  segment: TranscriptSegment
  index: number
  segState: DubbingSegmentState | undefined
  speakerName: string | undefined
  /** A thought: dubbed with an echo (see shared/innerVoice.ts). */
  innerVoice: boolean
  active: boolean
  expanded: boolean
  showDebug: boolean
  voiceDescription: string | undefined
  savedVoices: ReturnType<typeof loadSavedVoices>
  actions: SubtitleRowActions
}): JSX.Element {
  const segState = savedState ?? defaultDubbingSegmentState(segment.id)
  return (
    <div className={`ai-dubber-subtitle-row${active ? ' ai-dubber-subtitle-row-active' : ''}`}>
      <span className="ai-dubber-subtitle-index">{index + 1}</span>
      {speakerName && <span className="ai-dubber-speaker-chip">{speakerName}</span>}
      <input
        className="ai-dubber-subtitle-time"
        type="number"
        step={0.01}
        min={0}
        value={formatSeconds(segment.startTime)}
        onChange={(e) => actions.setTiming(segment.id, 'start', Number(e.target.value))}
      />
      <input
        className="ai-dubber-subtitle-time"
        type="number"
        step={0.01}
        min={0}
        value={formatSeconds(segment.endTime)}
        onChange={(e) => actions.setTiming(segment.id, 'end', Number(e.target.value))}
      />
      <input
        className="ai-dubber-subtitle-text"
        type="text"
        value={segment.editedText ?? segment.text}
        onClick={() => actions.select(segment)}
        onChange={(e) => actions.setText(segment.id, e.target.value)}
      />
      <EmotionChip
        performance={segState.performance}
        onClick={() => {
          if (!expanded) actions.toggleExpanded(segment.id)
        }}
      />
      {/* Always visible (the row's own buttons only show on hover): which
          lines are thoughts is worth seeing at a glance. */}
      {innerVoice && (
        <button className="ai-dubber-inner-voice-badge" title="Inner voice (a thought) -- dubbed with an echo. Click: a normal spoken line." onClick={() => actions.setInnerVoice(segment.id, false)}>
          💭
        </button>
      )}
      <span className="ai-dubber-row-actions">
        <button
          className={`ai-dubber-row-icon-button ai-dubber-inner-voice-button${innerVoice ? ' ai-dubber-inner-voice-on' : ''}`}
          title={innerVoice ? 'Inner voice (a thought) -- dubbed with an echo. Click: a normal spoken line.' : 'Spoken line. Click: inner voice (a thought), dubbed with an echo.'}
          aria-pressed={innerVoice}
          onClick={() => actions.setInnerVoice(segment.id, !innerVoice)}
        >
          💭
        </button>
        <button
          className={`ai-dubber-row-icon-button${expanded ? ' ai-dubber-row-icon-button-active' : ''}`}
          title={expanded ? 'Hide voice settings' : 'Voice, emotion, pitch, speed, volume'}
          onClick={() => actions.toggleExpanded(segment.id)}
        >
          ⚙
        </button>
        <button className="ai-dubber-row-icon-button" title="Preview this subtitle" onClick={() => actions.preview(segment)}>
          ▶
        </button>
        <button className="ai-dubber-row-icon-button ai-dubber-row-delete" title="Delete subtitle" onClick={() => actions.remove(segment.id)}>
          ✕
        </button>
      </span>

      {/* Collapsed by default: four controls per row, on 200+ rows, are
          almost always left at their defaults and crowded the Khmer line
          itself down to a sliver. Opened per row from the gear button. */}
      {expanded && (
        <div className="ai-dubber-subtitle-detail">
          <label className="ai-dubber-detail-field">
            Voice
            <select className="ai-dubber-subtitle-voice" value={segState.voiceId ?? ''} onChange={(e) => actions.setVoice(segment.id, e.target.value)}>
              <option value="">Voice…</option>
              {VOICE_MODELS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
              {/* The user's own recorded voices (savedVoices.ts). Without
                  these a row assigned one would render with no matching
                  <option> and so show up blank, as if it had no voice. */}
              {savedVoices.map((v) => (
                <option key={v.id} value={savedVoiceId(v.id)}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ai-dubber-detail-field">
            Pitch
            <input
              className="ai-dubber-subtitle-control"
              type="number"
              title="Pitch (semitones)"
              step={0.5}
              value={segState.pitch}
              onChange={(e) => actions.setControl(segment.id, 'pitch', Number(e.target.value))}
            />
          </label>
          <label className="ai-dubber-detail-field">
            Speed
            <input
              className="ai-dubber-subtitle-control"
              type="number"
              title="Speed"
              step={0.05}
              min={0.25}
              max={4}
              value={segState.speed}
              onChange={(e) => actions.setControl(segment.id, 'speed', Number(e.target.value))}
            />
          </label>
          <label className="ai-dubber-detail-field">
            Volume
            <input
              className="ai-dubber-subtitle-control"
              type="number"
              title="Volume (dB)"
              step={1}
              value={segState.volumeDb}
              onChange={(e) => actions.setControl(segment.id, 'volumeDb', Number(e.target.value))}
            />
          </label>
          <LinePerformanceEditor segmentId={segment.id} voiceDescription={voiceDescription} />
        </div>
      )}
      {showDebug && <LineDebugView debug={segState.debug} speaker={speakerName} />}
    </div>
  )
})

function AiDubberSubtitleEditor(): JSX.Element {
  const aiDubber = useAiDubber()
  const { seekTo, setPlaying } = usePlaybackControls()
  // Not subscribed to the playhead here: that re-rendered every row on every
  // frame of playback (2.4 fps with 2700 lines). PlayingLineTracker sets
  // this only when the playing line changes.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null)
  const { updateSegmentText } = useTranscript()
  const confirm = useConfirm()
  // Read straight from storage (see savedVoices.ts) -- the Voice Model panel
  // owns this list; this panel only needs it to label its own rows.
  const savedVoices = useMemo(() => loadSavedVoices(), [])
  const [pendingTranslationPreview, setPendingTranslationPreview] = useState<CloudRequestPreview | null>(null)
  const [translating, setTranslating] = useState(false)
  const [translationError, setTranslationError] = useState<string | null>(null)
  /** Which rows have their voice/pitch/speed/volume controls open. */
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  /** Debug view: what generation did per line (prompt, seed, scores).
   * Remembered per machine; off by default. */
  const [showOverlayPanel, setShowOverlayPanel] = useState(false)
  const [showDebug, setShowDebug] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cae-dubber-debug-v1') === '1'
    } catch {
      return false
    }
  })
  const toggleDebug = (): void => {
    setShowDebug((prev) => {
      try {
        localStorage.setItem('cae-dubber-debug-v1', prev ? '0' : '1')
      } catch {
        // remembered for this session only
      }
      return !prev
    })
  }
  /** The identity half of a line's control, for the prompt preview: a
   * catalog voice's description, nothing for a recorded voice. Same
   * fallback as generation (Male Adult) for a line with no voice at all. */
  const voiceDescriptionFor = (segmentId: string): string | undefined => {
    const st = aiDubber.getSegmentState(segmentId)
    const voiceId = st.voiceId ?? (st.speakerId ? aiDubber.state.speakers[st.speakerId]?.voiceId : undefined) ?? 'male-adult'
    return VOICE_MODELS.find((v) => v.id === voiceId)?.identity
  }
  const handleDetectEmotions = (): void => {
    void confirm({
      title: 'Detect emotions with Gemini?',
      message: [
        `The text of ${aiDubber.segments.length} subtitle lines (with speaker names) is sent to Gemini, which decides how each line should be acted, reading the lines around it. No audio or video is sent.`,
        'Lines you set by hand are kept. Without a working Gemini key the local analysis (emotion tags, punctuation, neighbouring lines) is used instead.'
      ],
      confirmLabel: 'Detect emotions'
    }).then((ok) => {
      if (ok) void aiDubber.detectEmotions()
    })
  }

  const toggleExpanded = useCallback((segmentId: string): void => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(segmentId)) next.delete(segmentId)
      else next.add(segmentId)
      return next
    })
  }, [])

  // One object for every row, never rebuilt: it calls through to the
  // latest context functions (several of them change whenever any line
  // does), so a memoized row re-renders only when ITS own line changed.
  const aiDubberRef = useRef(aiDubber)
  aiDubberRef.current = aiDubber
  const rowActions = useMemo<SubtitleRowActions>(
    () => ({
      select: (segment) => {
        aiDubberRef.current.setSelectedSubtitleId(segment.id)
        seekTo(segment.startTime)
      },
      preview: (segment) => {
        aiDubberRef.current.setSelectedSubtitleId(segment.id)
        seekTo(segment.startTime)
        setPlaying(true)
      },
      toggleExpanded,
      setTiming: (id, edge, time) => aiDubberRef.current.updateSegmentTiming(id, edge, time),
      setText: (id, text) => aiDubberRef.current.updateSegmentText(id, text),
      remove: (id) => aiDubberRef.current.removeSubtitle(id),
      setVoice: (id, voiceId) => aiDubberRef.current.setSegmentVoice(id, voiceId),
      setControl: (id, field, value) => aiDubberRef.current.setSegmentControl(id, field, value),
      setInnerVoice: (id, on) => aiDubberRef.current.setSegmentInnerVoice(id, on)
    }),
    [seekTo, setPlaying, toggleExpanded]
  )

  const handleTranslateClick = async (): Promise<void> => {
    if (aiDubber.segments.length === 0) return
    setTranslationError(null)
    const preview = await window.api.translation.previewTranslation(aiDubber.segments)
    setPendingTranslationPreview(preview)
  }

  const handleConfirmTranslate = (): void => {
    setPendingTranslationPreview(null)
    if (!aiDubber.state.videoMediaId) return
    const videoMediaId = aiDubber.state.videoMediaId
    setTranslating(true)
    void window.api.translation
      .translateSubtitles(`ai-dubber-translate-${Date.now()}`, aiDubber.segments, 'Khmer')
      .then((result) => {
        if (!result.ok) {
          setTranslationError(result.error.message)
          return
        }
        for (const { segmentId, translated } of result.data.translations) {
          updateSegmentText(videoMediaId, segmentId, translated)
        }
        if (result.data.missingSegmentIds.length > 0) {
          setTranslationError(`${result.data.missingSegmentIds.length} line(s) were not translated -- left unchanged.`)
        }
      })
      .finally(() => setTranslating(false))
  }

  return (
    <div className="ai-dubber-editor">
      <div className="panel-fixed-head">
        <div className="ai-dubber-editor-header-row">
          <h2>
            AI Dubber - Subtitle &amp; Script
            {/* Inline beside the title rather than a line of its own below
                the buttons -- that line cost a full row of the panel's
                height just to say a number. */}
            <span className="ai-dubber-count-badge">{aiDubber.segments.length}</span>
          </h2>
          <div className="ai-dubber-editor-header-actions">
            <button className="ai-dubber-remove-srt-button" title="Translate every subtitle into Khmer" onClick={() => void handleTranslateClick()} disabled={translating}>
              {translating ? 'Translating…' : 'Translate to Khmer'}
            </button>
          </div>
        </div>
        <EpisodeBar />
        {/* Its own row: the title row has no room left in a narrow panel. */}
        <div className="ai-dubber-performance-bar">
          <span className="ai-dubber-performance-bar-label">Emotion &amp; performance per line</span>
          <button
            className="ai-dubber-remove-srt-button"
            title="Decide how every line should be acted (emotion, intensity, style, pace), reading each line with the lines around it"
            onClick={handleDetectEmotions}
            disabled={aiDubber.analysisRunning || aiDubber.segments.length === 0}
          >
            {aiDubber.analysisRunning ? 'Detecting…' : '🎭 Detect Emotions'}
          </button>
          <button
            className="ai-dubber-remove-srt-button"
            title="Find the lines a character only thinks (inner voice): the echo in the original audio and the subtitle text. They are dubbed with an echo. Local, no Gemini."
            onClick={() => void aiDubber.detectInnerVoices()}
            disabled={aiDubber.innerVoiceRunning || aiDubber.segments.length === 0}
          >
            {aiDubber.innerVoiceRunning ? 'Listening…' : '💭 Inner Voice'}
          </button>
          <button
            className={`ai-dubber-remove-srt-button${showOverlayPanel ? ' ai-dubber-debug-toggle-on' : ''}`}
            title="Draw the subtitles on the video, and blur the original subtitles -- live in the Player, burned in on Export"
            onClick={() => setShowOverlayPanel((v) => !v)}
          >
            📝 Subtitle &amp; Blur
          </button>
          <button
            className={`ai-dubber-remove-srt-button${showDebug ? ' ai-dubber-debug-toggle-on' : ''}`}
            title="Show what generation did for each line: the exact VoxCPM2 prompt, seed, attempt and scores"
            onClick={toggleDebug}
          >
            Debug
          </button>
        </div>
        {showOverlayPanel && <SubtitleOverlayPanel onClose={() => setShowOverlayPanel(false)} />}
        {translationError && <div className="voiceover-recorder-error">{translationError}</div>}
        {aiDubber.analysisMessage && (
          <div className="ai-dubber-analysis-message">
            {aiDubber.analysisMessage}
            <button title="Dismiss" onClick={aiDubber.dismissAnalysisMessage}>
              ×
            </button>
          </div>
        )}
      </div>
      <div className="ai-dubber-subtitle-header">
        <span className="ai-dubber-subtitle-index">#</span>
        {Object.keys(aiDubber.state.speakers).length > 0 && <span className="ai-dubber-speaker-chip ai-dubber-speaker-chip-header">Speaker</span>}
        <span className="ai-dubber-subtitle-time">Start</span>
        <span className="ai-dubber-subtitle-time">End</span>
        <span className="ai-dubber-subtitle-text-label">Text (Editable)</span>
        {/* Sits at the right end of the column-header line, over the rows'
            own ✕ column, rather than up in the title row -- the destructive
            action for the whole list belongs with the list, and the title
            row had grown to two buttons wide. */}
        <button
          className="ai-dubber-remove-srt-button ai-dubber-remove-srt-inline"
          title="Remove SRT and start over"
          onClick={() => {
            void confirm({
              title: 'Remove SRT?',
              message: ['Every subtitle is removed, from this list and from the Timeline, with its voice, pitch and speed settings.', 'The video and any dubbing clips already generated stay on the Timeline.'],
              confirmLabel: 'Remove',
              danger: true
            }).then((ok) => {
              if (ok) aiDubber.clearWorkspace()
            })
          }}
        >
          Remove SRT
        </button>
      </div>
      <div ref={setListEl} className="panel-scroll-body editor-scroll ai-dubber-subtitle-list">
        {aiDubber.segments.length === 0 && <NoSubtitlesYet />}
        <PlayingLineTracker segments={aiDubber.segments} onChange={setPlayingSegmentId} />
        {/* Rendered in blocks of ROWS_PER_BLOCK: only the blocks near the
            visible part of the list hold their rows; the rest are empty
            boxes of the same height. A 1500-line episode used to build
            every row (16,500 elements, 90% of the page), and opening the
            panel or changing any line re-did all of them -- seconds of
            freeze on a slow CPU. */}
        {Array.from({ length: Math.ceil(aiDubber.segments.length / ROWS_PER_BLOCK) }, (_, block) => {
          const first = block * ROWS_PER_BLOCK
          const blockSegments = aiDubber.segments.slice(first, first + ROWS_PER_BLOCK)
          return (
            <LazyRowBlock key={block} root={listEl} rows={blockSegments.length} eager={block < 2}>
              {() =>
                blockSegments.map((segment, offset) => {
                  const index = first + offset
                  const segState = aiDubber.state.segments[segment.id]
                  const expanded = expandedRows.has(segment.id)
                  const speakerId = segState?.speakerId
                  return (
                    <SubtitleRow
                      key={segment.id}
                      segment={segment}
                      index={index}
                      segState={segState}
                      speakerName={speakerId ? (aiDubber.state.speakers[speakerId]?.name ?? speakerId) : undefined}
                      innerVoice={effectiveInnerVoice(segState, segment)}
                      active={aiDubber.selectedSubtitleId === segment.id || playingSegmentId === segment.id}
                      expanded={expanded}
                      showDebug={showDebug}
                      voiceDescription={expanded ? voiceDescriptionFor(segment.id) : undefined}
                      savedVoices={savedVoices}
                      actions={rowActions}
                    />
                  )
                })
              }
            </LazyRowBlock>
          )
        })}
        <button className="ai-dubber-add-subtitle-button" onClick={() => aiDubber.addSubtitle()}>
          + Add New Subtitle
        </button>
      </div>

      {pendingTranslationPreview && (
        <CloudConsentModal
          preview={pendingTranslationPreview}
          purpose="translation into Khmer"
          confirmLabel="Send & Translate"
          onCancel={() => setPendingTranslationPreview(null)}
          onConfirm={handleConfirmTranslate}
        />
      )}
    </div>
  )
}

function SpeakerCharacterList(): JSX.Element {
  const aiDubber = useAiDubber()
  const { seekTo, setPlaying } = usePlaybackControls()
  const { items } = useMedia()
  const savedVoices = useMemo(() => loadSavedVoices(), [])
  const speakers = Object.values(aiDubber.state.speakers)
  const [mergeTargetBySpeaker, setMergeTargetBySpeaker] = useState<Record<string, string>>({})
  const originalPreviewRef = useRef<HTMLVideoElement>(null)
  const previewEndRef = useRef<number | null>(null)
  const sourceMedia = items.find((item) => item.id === aiDubber.state.videoMediaId)
  const originalSource = sourceMedia?.proxyUrl ?? sourceMedia?.originalUrl

  useEffect(() => {
    const media = originalPreviewRef.current
    if (!media) return
    const stopAtLineEnd = (): void => {
      if (previewEndRef.current !== null && media.currentTime >= previewEndRef.current) media.pause()
    }
    media.addEventListener('timeupdate', stopAtLineEnd)
    return () => media.removeEventListener('timeupdate', stopAtLineEnd)
  }, [originalSource])

  const previewSpeaker = (speakerId: string): void => {
    const segment = aiDubber.segments.find((item) => item.speakerId === speakerId)
    if (!segment) return
    aiDubber.setSelectedSubtitleId(segment.id)
    const original = originalPreviewRef.current
    if (original) {
      previewEndRef.current = segment.endTime
      original.currentTime = segment.startTime
      void original.play()
    } else {
      seekTo(segment.startTime)
      setPlaying(true)
    }
  }

  return (
    <div className="ai-dubber-character-list">
      {originalSource && <video ref={originalPreviewRef} src={originalSource} className="ai-dubber-original-dialogue-preview" />}
      <div className="ai-dubber-character-list-title">
        <strong>Detected Characters</strong>
        <span>Identity uses voice embeddings; gender and age are predictions.</span>
      </div>
      {speakers.map((speaker) => {
        const selectedSegment = aiDubber.selectedSubtitleId
          ? aiDubber.segments.find((segment) => segment.id === aiDubber.selectedSubtitleId && segment.speakerId === speaker.id)
          : undefined
        const mergeTarget = mergeTargetBySpeaker[speaker.id] ?? ''
        return (
          <div className="ai-dubber-character-card" key={speaker.id}>
            <div className="ai-dubber-character-main">
              <input value={speaker.name} aria-label="Speaker name" onChange={(event) => aiDubber.renameSpeaker(speaker.id, event.target.value)} />
              <span>{speaker.segmentIds.length} lines</span>
              <span title="Voice-embedding identity confidence">Identity {Math.round(speaker.identityConfidence * 100)}%</span>
              <button onClick={() => previewSpeaker(speaker.id)}>Preview dialogue</button>
            </div>
            <div className="ai-dubber-character-fields">
              <label>
                Gender
                <select value={speaker.gender} onChange={(event) => aiDubber.setSpeakerGender(speaker.id, event.target.value as 'male' | 'female' | 'unknown')}>
                  <option value="unknown">Unknown</option><option value="male">Male</option><option value="female">Female</option>
                </select>
                <small>{speaker.genderManualOverride ? 'Manual' : `${Math.round(speaker.genderConfidence * 100)}% confidence`}</small>
              </label>
              <label>
                Age
                <select value={speaker.ageCategory} onChange={(event) => aiDubber.setSpeakerAge(speaker.id, event.target.value as 'child' | 'young' | 'adult' | 'elder' | 'unknown')}>
                  <option value="unknown">Unknown</option><option value="child">Child</option><option value="young">Young</option><option value="adult">Adult</option><option value="elder">Elder</option>
                </select>
                <small>{speaker.ageManualOverride ? 'Manual' : `${Math.round(speaker.ageConfidence * 100)}% confidence`}</small>
              </label>
              <label>
                Dubbing voice
                <select value={speaker.voiceId ?? ''} onChange={(event) => aiDubber.setSpeakerVoice(speaker.id, event.target.value)}>
                  <option value="">Not assigned</option>
                  {VOICE_MODELS.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                  {savedVoices.map((voice) => <option key={voice.id} value={savedVoiceId(voice.id)}>{voice.name}</option>)}
                </select>
                <small>Applied to every {speaker.name} subtitle</small>
              </label>
            </div>
            <div className="ai-dubber-character-actions">
              <select value={mergeTarget} onChange={(event) => setMergeTargetBySpeaker((previous) => ({ ...previous, [speaker.id]: event.target.value }))}>
                <option value="">Merge into…</option>
                {speakers.filter((candidate) => candidate.id !== speaker.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
              <button disabled={!mergeTarget} onClick={() => aiDubber.mergeSpeakers(speaker.id, mergeTarget)}>Merge</button>
              <button disabled={!selectedSegment || speaker.segmentIds.length < 2} title="Select one of this character's subtitle rows first" onClick={() => selectedSegment && aiDubber.splitSpeaker(speaker.id, [selectedSegment.id])}>
                Split selected line
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const ROWS_PER_BLOCK = 40
/** A row's height before it has been measured (one line of text). */
const ROW_ESTIMATE_PX = 52

/** A stretch of the subtitle list that holds its rows only while it is
 * near the visible part (within ~two screens), and otherwise an empty box
 * of the height it last measured -- so the scrollbar and the scroll
 * position never jump. The first blocks render at once (`eager`), so the
 * list never opens blank. */
function LazyRowBlock({ root, rows, eager, children }: { root: HTMLElement | null; rows: number; eager: boolean; children: () => ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const heightRef = useRef(rows * ROW_ESTIMATE_PX)
  const [near, setNear] = useState(eager)
  useEffect(() => {
    const el = ref.current
    if (!el || !root) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: '1200px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])
  // The real height, kept for when the block empties again.
  useEffect(() => {
    const el = ref.current
    if (!el || !near) return
    const observer = new ResizeObserver(() => {
      if (el.offsetHeight > 0) heightRef.current = el.offsetHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])
  return (
    <div ref={ref} className="ai-dubber-subtitle-block" style={near ? undefined : { height: heightRef.current }}>
      {near ? children() : null}
    </div>
  )
}
