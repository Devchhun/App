import { useEffect, useRef, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { isPastRecordingBound } from '../timeline/recordingBounds'
import { useAiDubber } from './AiDubberContext'
import { VOICE_MODELS } from './voiceModels'
import { useSavedVoices, savedVoiceToModel } from './useSavedVoices'
import { savedVoiceId } from './savedVoices'
import { useKiriVoices, kiriVoiceToModel } from './useKiriVoices'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from './voxcpmSettings'
import { TOGETHER_MAX_EXTRA } from '@shared/dubbingTogether'
import { saveReviewPlace } from './detectGenderResume'
import { useVoicePreview } from './useVoicePreview'

/** Which voices the review lists: the user's cloned voices only (KiriTTS
 * clones, or VoxCPM2's saved / custom voices), or every voice. Kept between
 * openings. */
type VoiceTab = 'cloned' | 'all'
/** Detect Gender's own picks, per story (its video), for this run of the
 * app only: what colours the voices already cast. Never saved. */
const pickedByStory = new Map<string, Record<string, string>>()
/** ...and kept through a reload of the window (sessionStorage lasts as
 * long as the app is open, which is how long the colours are meant to). */
const PICKED_KEY = 'cae-detect-gender-picked-v1'
try {
  const saved = JSON.parse(sessionStorage.getItem(PICKED_KEY) ?? '{}') as Record<string, Record<string, string>>
  for (const [story, picks] of Object.entries(saved)) pickedByStory.set(story, picks)
} catch {
  // No colours carried over: the review opens plain.
}

const VOICE_TAB_KEY = 'cae-detect-gender-voice-tab'

function loadVoiceTab(): VoiceTab {
  try {
    return localStorage.getItem(VOICE_TAB_KEY) === 'cloned' ? 'cloned' : 'all'
  } catch {
    return 'all'
  }
}

function formatSeconds(value: number): string {
  return value.toFixed(2)
}

interface Props {
  initialIndex: number
  onClose: () => void
}

/** "Detect Gender" review -- steps through every subtitle one at a time,
 * playing that exact time range from the ORIGINAL video/audio (never the
 * Timeline's composited render, see this feature's own plan for why) so the
 * user can actually hear the line before picking its voice, instead of
 * trusting a silent background heuristic alone. Real per-segment pitch
 * detection (AiDubberContext.detectGenderForSegment, the same one the bulk
 * "detect all" loop uses) still runs, on demand as each segment is reached,
 * and pre-highlights its matching voice as "Suggested" -- but any button can
 * be clicked. Clicking one both assigns it and advances, matching how
 * Back/Skip already step through the list. */
export function DetectGenderReviewModal({ initialIndex, onClose }: Props): JSX.Element {
  const aiDubber = useAiDubber()
  const { items } = useMedia()
  const [index, setIndex] = useState(initialIndex)
  const videoRef = useRef<HTMLVideoElement>(null)
  const requestedRef = useRef<Set<string>>(new Set())
  /** The user's latest pick per gender in this review: the next line of
   * that gender is suggested in the same voice, not the plain Male/Female
   * Adult -- that plain suggestion, ticked on the next line right after a
   * click, read as "my click jumped to another voice". */
  const lastPickRef = useRef<Partial<Record<'male' | 'female', string>>>({})
  /** A pick just made: shown ticked for a moment before the next line. */
  /** Line -> the voice chosen for it in this story since the app was
   * started (kept while the review is closed and opened again; another
   * story starts plain). */
  const storyKey = aiDubber.state.videoMediaId ?? ''
  const [pickedHere, setPickedState] = useState<Record<string, string>>(() => pickedByStory.get(storyKey) ?? {})
  const setPickedHere = (update: (prev: Record<string, string>) => Record<string, string>): void =>
    setPickedState((prev) => {
      const next = update(prev)
      pickedByStory.set(storyKey, next)
      try {
        sessionStorage.setItem(PICKED_KEY, JSON.stringify(Object.fromEntries(pickedByStory)))
      } catch {
        // Kept in memory only.
      }
      return next
    })
  const [justPicked, setJustPicked] = useState<{ line: number; voiceId: string; name: string } | null>(null)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** "Speak together" switched on for the line shown, before it has a
   * second voice (a line that has one shows it on by itself). */
  const [togetherOpen, setTogetherOpen] = useState(false)
  useEffect(() => () => {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
  }, [])
  // Above the `if (!segment)` early return below -- hooks cannot sit behind
  // a conditional return.
  const savedVoices = useSavedVoices()
  // On the KiriTTS engine a line is spoken only in a KiriTTS voice, so the
  // review offers the account's voices (its male/female Khmer voices and
  // its clones) instead of the VoxCPM2 catalog.
  const [engine] = useState(() => parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey())).engine)
  const kiri = useKiriVoices(engine === 'kiritts')
  // A voice's round icon plays its kept sound: a saved voice's recording, or a
  // KiriTTS voice's sample, made the first time and kept for every project.
  // A catalog voice has neither: it says this line, free, on this computer or
  // through Edge.
  const voicePreview = useVoicePreview({
    customVoiceReferenceAudioPath: aiDubber.state.customVoiceReferenceAudioPath,
    customVoiceReferenceText: aiDubber.state.customVoiceReferenceText
  })
  const hearing = voicePreview.preview
  const stopHearing = voicePreview.stop
  const [voiceTab, setVoiceTabState] = useState<VoiceTab>(loadVoiceTab)
  const setVoiceTab = (tab: VoiceTab): void => {
    setVoiceTabState(tab)
    try {
      localStorage.setItem(VOICE_TAB_KEY, tab)
    } catch {
      // Remembering the tab is only a convenience.
    }
  }

  const segments = aiDubber.segments
  const segment = segments[index]
  // The line shown is the place the review is left at: kept as it moves,
  // so closing the review -- or the window reloading under it -- opens it
  // here again (detectGenderResume.ts).
  const selectedSubtitleId = aiDubber.selectedSubtitleId
  useEffect(() => {
    if (segment) saveReviewPlace(storyKey, segment.id, selectedSubtitleId)
  }, [storyKey, segment?.id, selectedSubtitleId])
  // The line's own video and its time in that file -- after Batch Load the
  // Timeline holds several videos, and a line's Timeline time is not a time
  // in the first one.
  const source = segment ? aiDubber.sourceOfLine(segment) : null
  const media = source ? items.find((m) => m.id === source.mediaId) : undefined
  const videoSrc = media?.proxyUrl ?? media?.originalUrl
  const sourceStart = source?.start ?? 0
  const sourceEnd = source?.end ?? 0

  /** Plays the current line from its start (once the video can seek). */
  const playLine = (): void => {
    const video = videoRef.current
    if (!video || !source) return
    const start = (): void => {
      video.currentTime = sourceStart
      void video.play().catch(() => undefined)
    }
    if (video.readyState >= 1) start()
    else video.addEventListener('loadedmetadata', start, { once: true })
  }
  const replay = (): void => {
    stopHearing()
    playLine()
  }

  // Plays the line as soon as it is shown -- opening Detect Gender and
  // every Back/Skip/choice -- so each line is heard (and seen) without a
  // click; it stops at the line's end. It also requests real detection for
  // the line exactly once -- mirrors detectGenders' own
  // detectedSegmentIdsRef guard so re-rendering this component never
  // re-requests the same segment.
  useEffect(() => {
    // A test of the last line must not talk over this one.
    stopHearing()
    if (segment) playLine()
    if (!segment) return
    const existing = aiDubber.getSegmentState(segment.id)
    if (existing.detectedGender === 'unknown' && !requestedRef.current.has(segment.id)) {
      requestedRef.current.add(segment.id)
      void aiDubber.detectGenderForSegment(segment, lastPickRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the reviewed segment (or the video it is in) changes; aiDubber's own callbacks are stable.
  }, [segment?.id, videoSrc])

  // Auto-stops playback once it reaches this segment's own end -- same
  // bound-check VoiceoverRecorder.tsx's guided playback already uses,
  // applied here so "Replay" always plays just the one line, not into
  // whatever comes after it.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !segment) return
    const handleTimeUpdate = (): void => {
      if (isPastRecordingBound(video.currentTime, sourceEnd)) video.pause()
    }
    video.addEventListener('timeupdate', handleTimeUpdate)
    return () => video.removeEventListener('timeupdate', handleTimeUpdate)
  }, [segment, sourceEnd])

  if (!segment) return <></>

  const goToIndex = (next: number): void => {
    // Back/Skip during a pick's moment of confirmation wins over it.
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
    if (next >= segments.length) {
      onClose()
      return
    }
    setTogetherOpen(false)
    setIndex(Math.max(0, next))
  }

  const segmentState = aiDubber.getSegmentState(segment.id)

  // The pick is ticked on the button that was clicked, and named, for a
  // moment -- then the next line. (Advancing at once showed the NEXT line's
  // suggestion ticked under the mouse instead.)
  const chooseVoice = (voice: { id: string; name: string; gender: string }): void => {
    if (advanceTimerRef.current) return
    aiDubber.setSegmentVoice(segment.id, voice.id)
    setPickedHere((prev) => ({ ...prev, [segment.id]: voice.id }))
    const gender = voice.gender === 'male' || voice.gender === 'female' ? voice.gender : segmentState.detectedGender
    if (gender === 'male' || gender === 'female') lastPickRef.current = { ...lastPickRef.current, [gender]: voice.id }
    setJustPicked({ line: index + 1, voiceId: voice.id, name: voice.name })
    const next = index + 1
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null
      goToIndex(next)
    }, 260)
  }

  // A thought, not a line said aloud: Generate gives it the echo.
  const echoOn = aiDubber.isInnerVoice(segment.id)
  // Several people saying the line at once: its own voice (1) and the
  // others picked here, generated one over the other. While this is on, a
  // click adds or takes away a voice and the review stays on the line.
  const togetherVoices = segmentState.togetherVoiceIds ?? []
  const together = togetherOpen || togetherVoices.length > 0
  const ownVoice = segmentState.voiceManuallyAssigned ? segmentState.voiceId : undefined
  const toggleTogether = (): void => {
    if (together) aiDubber.setSegmentTogetherVoices(segment.id, [])
    setTogetherOpen(!together)
  }
  const toggleTogetherVoice = (voice: { id: string; name: string; gender: string }): void => {
    if (!ownVoice) {
      aiDubber.setSegmentVoice(segment.id, voice.id)
      aiDubber.setSegmentTogetherVoices(segment.id, togetherVoices.filter((id) => id !== voice.id))
      setPickedHere((prev) => ({ ...prev, [segment.id]: voice.id }))
    } else if (voice.id === ownVoice) {
      // Taking the first voice away: the next one becomes the line's own.
      if (togetherVoices.length === 0) return
      aiDubber.setSegmentVoice(segment.id, togetherVoices[0])
      aiDubber.setSegmentTogetherVoices(segment.id, togetherVoices.slice(1))
      setPickedHere((prev) => ({ ...prev, [segment.id]: togetherVoices[0] }))
    } else if (togetherVoices.includes(voice.id)) {
      aiDubber.setSegmentTogetherVoices(segment.id, togetherVoices.filter((id) => id !== voice.id))
    } else if (togetherVoices.length < TOGETHER_MAX_EXTRA) {
      aiDubber.setSegmentTogetherVoices(segment.id, [...togetherVoices, voice.id])
    }
  }
  /** 1 for the line's own voice, 2.. for the others, 0 for a voice not in it. */
  const togetherCount = (ownVoice ? 1 : 0) + togetherVoices.length
  const togetherPlace = (voiceId: string): number => (voiceId === ownVoice ? 1 : togetherVoices.includes(voiceId) ? togetherVoices.indexOf(voiceId) + 2 : 0)

  // Catalog voices plus the user's own recorded ones -- this review is where
  // a character's voice actually gets decided, so a voice recorded FOR that
  // character has to be choosable here, not only in the Voice Model grid.
  // Always in ONE fixed order (the Voice Model panel's), never re-sorted by
  // the line's gender: each click moves on to the next line, and a list
  // that re-sorted for every line (and again once its gender was detected)
  // had every button jumping up and down under the mouse.
  const allVoices =
    engine === 'kiritts'
      ? kiri.state.status === 'ready'
        ? kiri.state.voices.map(kiriVoiceToModel)
        : []
      : [...VOICE_MODELS, ...savedVoices.map((v) => savedVoiceToModel(v, savedVoiceId(v.id)))]
  // "Cloned": the voices the user made -- KiriTTS clones (and VoxCPM2
  // copies), or VoxCPM2's saved recordings and Custom Voice.
  const clonedVoices = allVoices.filter((v) => v.category === 'custom')
  const pickableVoices = voiceTab === 'cloned' ? clonedVoices : allVoices
  // The line's voice when it is not among the ones shown (an "All" pick
  // seen from "Cloned"), so the current choice is never invisible.
  const currentHidden = segmentState.voiceId && !pickableVoices.some((v) => v.id === segmentState.voiceId) ? allVoices.find((v) => v.id === segmentState.voiceId)?.name : undefined
  // The voices chosen for this story in Detect Gender since the app was
  // started, each in a colour of its own (by its place in the full list,
  // so a voice keeps its colour whatever is picked next) with how many
  // lines it was given -- which characters are cast so far, at a glance.
  // A story not worked on yet shows every voice plain, as before.
  const usedLines = new Map<string, number>()
  for (const voiceId of Object.values(pickedHere)) usedLines.set(voiceId, (usedLines.get(voiceId) ?? 0) + 1)
  const voiceHue = (voiceId: string): number => Math.round((Math.max(0, allVoices.findIndex((v) => v.id === voiceId)) * 137.508 + 18) % 360)

  const kiriNote =
    engine !== 'kiritts'
      ? null
      : kiri.state.status === 'no-key'
        ? 'Add your KiriTTS API key in Settings > AI API Keys to choose its voices.'
        : kiri.state.status === 'error'
          ? kiri.state.error
          : kiri.state.status !== 'ready'
            ? 'Loading your KiriTTS voices…'
            : null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel detect-gender-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header detect-gender-header">
          <div className="detect-gender-title">
            <span className="detect-gender-title-icon" aria-hidden="true">◉</span>
            <div>
              <h2>Detect Gender</h2>
              <p>Preview each line and choose the best matching voice</p>
            </div>
          </div>
          <button className="modal-close detect-gender-close" aria-label="Close Detect Gender" onClick={onClose}>×</button>
        </div>

        <div className="detect-gender-progress">
          <span>Subtitle {index + 1} of {segments.length}</span>
          <span className="detect-gender-progress-track">
            <span className="detect-gender-progress-fill" style={{ width: `${((index + 1) / segments.length) * 100}%` }} />
          </span>
          <strong>{Math.round(((index + 1) / segments.length) * 100)}%</strong>
        </div>

        <div className="detect-gender-body">
          <div className="detect-gender-video-pane">
            <div className="detect-gender-section-label">Original video</div>
            <div className="detect-gender-video-frame">
              {videoSrc && <video ref={videoRef} src={videoSrc} preload="auto" playsInline className="detect-gender-video" />}
              {!videoSrc && <div className="detect-gender-video-empty">Video preview unavailable</div>}
            </div>
            <button className="detect-gender-replay-button" onClick={replay} disabled={!videoSrc}>
              <span aria-hidden="true">▶</span> Replay current dialogue
            </button>
          </div>

          <div className="detect-gender-info-pane">
            <div className="detect-gender-section-label">Current subtitle</div>
            {/* Editable in place: this is where the user is already
                listening to the line, so a wrong word gets fixed here rather
                than remembered and hunted down in the row list afterwards.
                Same updateSegmentText the row list's own field uses. */}
            <textarea
              className="detect-gender-text-box detect-gender-text-edit"
              lang="km"
              rows={2}
              value={segment.editedText ?? segment.text}
              onChange={(e) => aiDubber.updateSegmentText(segment.id, e.target.value)}
              spellCheck={false}
            />
            <div className="detect-gender-time-box">
              <span>Timestamp</span>
              <strong>{formatSeconds(segment.startTime)}s → {formatSeconds(segment.endTime)}s</strong>
            </div>

            <div className="detect-gender-line-options">
              <button
                className={`detect-gender-option-button${echoOn ? ' detect-gender-option-button-on' : ''}`}
                aria-pressed={echoOn}
                title="A voice in the character's mind (a thought): Generate adds an echo to this line."
                onClick={() => aiDubber.setSegmentInnerVoice(segment.id, !echoOn)}
              >
                <span aria-hidden="true">{echoOn ? '☑' : '☐'}</span> Echo <small>inner voice</small>
              </button>
              <button
                className={`detect-gender-option-button${together ? ' detect-gender-option-button-on' : ''}`}
                aria-pressed={together}
                title="Several people say this line at once: pick 2 to 5 voices. Generate makes each one and lays them over each other, a moment apart."
                onClick={toggleTogether}
              >
                <span aria-hidden="true">{together ? '☑' : '☐'}</span> Speak together <small>{together ? `${togetherCount} of ${TOGETHER_MAX_EXTRA + 1} voices` : 'many voices'}</small>
              </button>
            </div>
            {together && (
              <div className="detect-gender-together-bar">
                {/* The voices picked so far, in order -- the list below may be
                    scrolled away from them. A chip's x takes its voice away. */}
                <div className="detect-gender-together-chips">
                  {togetherCount === 0 && <span className="detect-gender-together-hint">Click the voices that say this line</span>}
                  {[...(ownVoice ? [ownVoice] : []), ...togetherVoices].map((voiceId, i) => {
                    const voice = allVoices.find((v) => v.id === voiceId)
                    return (
                      <button key={voiceId} className="detect-gender-together-chip" title="Take this voice away" disabled={!voice || togetherCount === 1} onClick={() => voice && toggleTogetherVoice(voice)}>
                        <b>{i + 1}</b>
                        <span>{voice?.name ?? voiceId}</span>
                        {togetherCount > 1 && <i aria-hidden="true">×</i>}
                      </button>
                    )
                  })}
                </div>
                {/* The voices are kept as they are clicked; this confirms
                    them and moves on, like a click does on a plain line. */}
                <button className="detect-gender-approve-button" disabled={togetherCount < 2} title={togetherCount < 2 ? 'Pick at least 2 voices' : undefined} onClick={() => goToIndex(index + 1)}>
                  ✓ Approve
                </button>
              </div>
            )}

            <div className="detect-gender-voice-heading">
              <div>
                <strong>Choose a voice</strong>
                <span className={justPicked ? 'detect-gender-last-pick' : undefined}>{justPicked ? `✓ Line ${justPicked.line}: ${justPicked.name}` : 'Listen first, then select the closest match'}</span>
              </div>
              {segmentState.detectedGender !== 'unknown' && <span className="detect-gender-result-pill">Suggested: {segmentState.detectedGender}</span>}
            </div>
            <div className="detect-gender-voice-tabs">
              <button className={voiceTab === 'cloned' ? 'detect-gender-voice-tab detect-gender-voice-tab-active' : 'detect-gender-voice-tab'} onClick={() => setVoiceTab('cloned')}>
                Cloned ({clonedVoices.length})
              </button>
              <button className={voiceTab === 'all' ? 'detect-gender-voice-tab detect-gender-voice-tab-active' : 'detect-gender-voice-tab'} onClick={() => setVoiceTab('all')}>
                All ({allVoices.length})
              </button>
              {currentHidden && <span className="detect-gender-voice-current">Now: {currentHidden}</span>}
            </div>
            {kiriNote && <div className="ai-dubber-kiri-note">{kiriNote}</div>}
            {!kiriNote && voiceTab === 'cloned' && clonedVoices.length === 0 && (
              <div className="ai-dubber-kiri-note">
                {engine === 'kiritts' ? 'No cloned voices yet -- clone one in Voice Model > KiriTTS (🎙 Clone voice).' : 'No saved voices yet -- record or add one in Voice Model > Custom.'}
              </div>
            )}
            {hearing && hearing.status !== 'playing' && (
              <div className={`ai-dubber-voice-test-status${hearing.status === 'error' ? ' ai-dubber-voice-test-error' : ''}`}>
                {hearing.status === 'generating' ? `Getting ${allVoices.find((v) => v.id === hearing.voiceId)?.name ?? 'this voice'}…` : hearing.error}
                <button aria-label="Close" onClick={stopHearing}>
                  ×
                </button>
              </div>
            )}
            <div className="detect-gender-voice-grid">
              {pickableVoices.map((voice) => {
                // The one voice assigned so far: ticked when the user chose
                // it, marked "Suggested" when detection put it there --
                // the two must never look alike. Exactly one button.
                const selected = segmentState.voiceId === voice.id
                const picked = selected && !!segmentState.voiceManuallyAssigned
                const used = usedLines.get(voice.id) ?? 0
                const place = together ? togetherPlace(voice.id) : 0
                const hearingThis = hearing?.voiceId === voice.id && hearing.status !== 'error' ? hearing.status : null
                return (
                  <div key={voice.id} className="detect-gender-voice-item">
                  <button
                    className={`detect-gender-voice-button${picked ? ' detect-gender-voice-button-selected' : selected ? ' detect-gender-voice-button-suggested' : ''}${used > 0 ? ' detect-gender-voice-button-used' : ''}${place > 1 ? ' detect-gender-voice-button-together' : ''}`}
                    style={used > 0 ? ({ '--used-hue': voiceHue(voice.id) } as React.CSSProperties) : undefined}
                    title={used > 0 ? `${voice.name}: chosen for ${used} line${used === 1 ? '' : 's'}` : undefined}
                    onClick={() => (together ? toggleTogetherVoice(voice) : chooseVoice(voice))}
                  >
                    {/* Room for the round listen button, which sits over it:
                        a button cannot go inside this one. */}
                    <span className="detect-gender-voice-avatar-space" aria-hidden="true" />
                    <span className="detect-gender-voice-copy">
                      <strong>{voice.name}</strong>
                      <small>{voice.description}</small>
                    </span>
                    {used > 0 && <span className="detect-gender-used-count">{used}</span>}
                    {place > 0 && <span className="detect-gender-together-place">{place}</span>}
                    {picked && !together && <span className="detect-gender-suggested-badge">✓</span>}
                    {selected && !picked && <span className="detect-gender-suggestion-tag">Suggested</span>}
                  </button>
                  <button
                    className={`detect-gender-voice-avatar detect-gender-voice-avatar-${voice.gender} detect-gender-voice-listen${hearingThis ? ' detect-gender-voice-listen-on' : ''}`}
                    style={used > 0 ? ({ '--used-hue': voiceHue(voice.id) } as React.CSSProperties) : undefined}
                    title={hearingThis ? 'Stop' : `Listen to ${voice.name}`}
                    aria-label={hearingThis ? 'Stop' : `Listen to ${voice.name}`}
                    onClick={() => {
                      if (hearingThis) {
                        stopHearing()
                        return
                      }
                      videoRef.current?.pause()
                      if (!voicePreview.playKept(voice)) voicePreview.play(voice, segment.editedText ?? segment.text, engine)
                    }}
                  >
                    {hearingThis === 'generating' ? '…' : hearingThis === 'playing' ? '■' : '▶'}
                  </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="detect-gender-actions">
          <span>{segments.length - index - 1} subtitles remaining</span>
          <div>
            <button className="detect-gender-nav-button" disabled={index === 0} onClick={() => goToIndex(index - 1)}>Back</button>
            <button className="detect-gender-nav-button detect-gender-skip-button" onClick={() => goToIndex(index + 1)}>Skip</button>
            <button className="detect-gender-nav-button detect-gender-done-button" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}
