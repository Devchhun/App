import { useEffect, useMemo, useRef, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { usePlaybackTime, usePlaybackControls } from '../playback/PlaybackContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useAiDubber } from './AiDubberContext'
import { VOICE_MODELS } from './voiceModels'
import { loadSavedVoices, savedVoiceId } from './savedVoices'
import { CloudConsentModal } from '../suggestions/CloudConsentModal'
import { useConfirm } from '../ui/ConfirmDialog'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'

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
  const { items, importFromDialog } = useMedia()
  const aiDubber = useAiDubber()
  const { pendingVideoId, setPendingVideoId } = aiDubber
  const [srtFileName, setSrtFileName] = useState<string | null>(null)
  const [srtText, setSrtText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Computed once, from whatever videos were already imported before this
  // panel mounted -- lazily via useRef (not re-evaluated on every render)
  // so "newly imported" below means "appeared after I started watching."
  const knownVideoIdsRef = useRef<Set<string>>()
  if (!knownVideoIdsRef.current) knownVideoIdsRef.current = new Set(items.filter((m) => m.kind === 'video').map((m) => m.id))

  // Auto-selects the newly-imported video once it lands in MediaContext's
  // `items` (import is async -- see ImportPanel.tsx's own identical "+Add to
  // Timeline" pattern) rather than making the user separately pick it from a
  // dropdown afterward (NarrationScriptPanel.tsx's own setup form does the
  // latter) -- the spec asks for "after import show selected video
  // name/status" as one continuous action from a single button.
  useEffect(() => {
    if (pendingVideoId) return
    const newVideo = items.find((m) => m.kind === 'video' && m.readyToUse && !knownVideoIdsRef.current!.has(m.id))
    if (newVideo) setPendingVideoId(newVideo.id)
  }, [items, pendingVideoId])

  const pendingVideo = pendingVideoId ? items.find((m) => m.id === pendingVideoId) : undefined

  const handleAddVideo = async (): Promise<void> => {
    setError(null)
    await importFromDialog()
  }

  const handleAddSrt = async (): Promise<void> => {
    setError(null)
    const result = await window.api.transcription.importSrtFile()
    if (result.canceled || !result.srtText) return
    const fileName = result.fileName ?? 'subtitles.srt'
    setSrtFileName(fileName)
    setSrtText(result.srtText)
    if (pendingVideoId) {
      const prepared = aiDubber.prepareWorkspace({ videoMediaId: pendingVideoId, srtText: result.srtText, srtFileName: fileName })
      if (prepared.segmentCount === 0) setError('No valid subtitle segments were found in this SRT file.')
    }
  }

  // If Add SRT happened before the video finished importing, prepare as soon
  // as both are actually available.
  useEffect(() => {
    if (pendingVideoId && srtText && !aiDubber.state.videoMediaId) {
      aiDubber.prepareWorkspace({ videoMediaId: pendingVideoId, srtText, srtFileName: srtFileName ?? 'subtitles.srt' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prepareWorkspace is a stable context callback; only re-run when the two real inputs change.
  }, [pendingVideoId, srtText, srtFileName])

  return (
    <div className="ai-dubber-setup">
      <div className="panel-fixed-head">
        <h2>AI Dubber - Subtitle &amp; Script</h2>
        <p className="ai-dubber-setup-subtitle">Add your video and SRT subtitle to generate dubbing</p>
      </div>

      <div className="ai-dubber-setup-buttons">
        <button className="ai-dubber-setup-add-button" onClick={() => void handleAddVideo()}>
          <span className="ai-dubber-setup-add-button-title">Add Video</span>
          <span className="ai-dubber-setup-add-button-hint">MP4, MOV, AVI…</span>
        </button>
        <button className="ai-dubber-setup-add-button" onClick={() => void handleAddSrt()}>
          <span className="ai-dubber-setup-add-button-title">Add SRT</span>
          <span className="ai-dubber-setup-add-button-hint">.srt file</span>
        </button>
      </div>

      {pendingVideo && <div className="narration-setup-file-chip">{pendingVideo.fileName}</div>}
      {srtFileName && <div className="narration-setup-file-chip">{srtFileName}</div>}
      {error && <div className="voiceover-recorder-error">{error}</div>}
    </div>
  )
}

function AiDubberSubtitleEditor(): JSX.Element {
  const aiDubber = useAiDubber()
  const { seekTo, setPlaying } = usePlaybackControls()
  const { currentTime } = usePlaybackTime()
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

  const toggleExpanded = (segmentId: string): void => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(segmentId)) next.delete(segmentId)
      else next.add(segmentId)
      return next
    })
  }

  const handleRowClick = (segment: TranscriptSegment): void => {
    aiDubber.setSelectedSubtitleId(segment.id)
    seekTo(segment.startTime)
  }

  const handlePreview = (segment: TranscriptSegment): void => {
    aiDubber.setSelectedSubtitleId(segment.id)
    seekTo(segment.startTime)
    setPlaying(true)
  }

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
        {translationError && <div className="voiceover-recorder-error">{translationError}</div>}
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
              title: 'Remove video and SRT?',
              message: ['Per-subtitle voice, pitch and speed settings will be lost.', 'Dubbing clips already generated on the Timeline are kept.'],
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
      <div className="panel-scroll-body editor-scroll ai-dubber-subtitle-list">
        {aiDubber.segments.map((segment, index) => {
          const segState = aiDubber.getSegmentState(segment.id)
          const isPlaying = currentTime >= segment.startTime && currentTime < segment.endTime
          const expanded = expandedRows.has(segment.id)
          return (
            <div
              key={segment.id}
              className={`ai-dubber-subtitle-row${aiDubber.selectedSubtitleId === segment.id || isPlaying ? ' ai-dubber-subtitle-row-active' : ''}`}
            >
              <span className="ai-dubber-subtitle-index">{index + 1}</span>
              {segState.speakerId && <span className="ai-dubber-speaker-chip">{aiDubber.state.speakers[segState.speakerId]?.name ?? segState.speakerId}</span>}
              <input
                className="ai-dubber-subtitle-time"
                type="number"
                step={0.01}
                min={0}
                value={formatSeconds(segment.startTime)}
                onChange={(e) => aiDubber.updateSegmentTiming(segment.id, 'start', Number(e.target.value))}
              />
              <input
                className="ai-dubber-subtitle-time"
                type="number"
                step={0.01}
                min={0}
                value={formatSeconds(segment.endTime)}
                onChange={(e) => aiDubber.updateSegmentTiming(segment.id, 'end', Number(e.target.value))}
              />
              <input
                className="ai-dubber-subtitle-text"
                type="text"
                value={segment.editedText ?? segment.text}
                onClick={() => handleRowClick(segment)}
                onChange={(e) => aiDubber.updateSegmentText(segment.id, e.target.value)}
              />
              <span className="ai-dubber-row-actions">
                <button
                  className={`ai-dubber-row-icon-button${expanded ? ' ai-dubber-row-icon-button-active' : ''}`}
                  title={expanded ? 'Hide voice settings' : 'Voice, pitch, speed, volume'}
                  onClick={() => toggleExpanded(segment.id)}
                >
                  ⚙
                </button>
                <button className="ai-dubber-row-icon-button" title="Preview this subtitle" onClick={() => handlePreview(segment)}>
                  ▶
                </button>
                <button className="ai-dubber-row-icon-button ai-dubber-row-delete" title="Delete subtitle" onClick={() => aiDubber.removeSubtitle(segment.id)}>
                  ✕
                </button>
              </span>

              {/* Collapsed by default: four controls per row, on 200+ rows,
                  are almost always left at their defaults and crowded the
                  Khmer line itself down to a sliver. Opened per row from the
                  gear button above. */}
              {expanded && (
                <div className="ai-dubber-subtitle-detail">
                  <label className="ai-dubber-detail-field">
                    Voice
                    <select className="ai-dubber-subtitle-voice" value={segState.voiceId ?? ''} onChange={(e) => aiDubber.setSegmentVoice(segment.id, e.target.value)}>
                      <option value="">Voice…</option>
                      {VOICE_MODELS.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                      {/* The user's own recorded voices (savedVoices.ts).
                          Without these a row assigned one would render with
                          no matching <option> and so show up blank, as if it
                          had no voice at all. */}
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
                      onChange={(e) => aiDubber.setSegmentControl(segment.id, 'pitch', Number(e.target.value))}
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
                      onChange={(e) => aiDubber.setSegmentControl(segment.id, 'speed', Number(e.target.value))}
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
                      onChange={(e) => aiDubber.setSegmentControl(segment.id, 'volumeDb', Number(e.target.value))}
                    />
                  </label>
                </div>
              )}
            </div>
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

