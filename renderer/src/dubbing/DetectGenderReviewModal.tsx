import { useEffect, useRef, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { isPastRecordingBound } from '../timeline/recordingBounds'
import { useAiDubber } from './AiDubberContext'
import { VOICE_MODELS } from './voiceModels'
import { useSavedVoices, savedVoiceToModel } from './useSavedVoices'
import { savedVoiceId } from './savedVoices'

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
  // Above the `if (!segment)` early return below -- hooks cannot sit behind
  // a conditional return.
  const savedVoices = useSavedVoices()

  const segments = aiDubber.segments
  const segment = segments[index]
  const media = aiDubber.state.videoMediaId ? items.find((m) => m.id === aiDubber.state.videoMediaId) : undefined
  const videoSrc = media?.proxyUrl ?? media?.originalUrl

  const replay = (): void => {
    const video = videoRef.current
    if (!video || !segment) return
    video.currentTime = segment.startTime
    void video.play()
  }

  // Seeks to the new segment's start (paused) whenever the reviewed segment
  // changes, and requests real detection for it exactly once -- mirrors
  // detectGenders' own detectedSegmentIdsRef guard so re-rendering this
  // component never re-requests the same segment.
  useEffect(() => {
    const video = videoRef.current
    if (video && segment) {
      video.pause()
      video.currentTime = segment.startTime
    }
    if (!segment) return
    const existing = aiDubber.getSegmentState(segment.id)
    if (existing.detectedGender === 'unknown' && !requestedRef.current.has(segment.id)) {
      requestedRef.current.add(segment.id)
      void aiDubber.detectGenderForSegment(segment)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the reviewed segment itself changes; aiDubber's own callbacks are stable.
  }, [segment?.id])

  // Auto-stops playback once it reaches this segment's own end -- same
  // bound-check VoiceoverRecorder.tsx's guided playback already uses,
  // applied here so "Replay" always plays just the one line, not into
  // whatever comes after it.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !segment) return
    const handleTimeUpdate = (): void => {
      if (isPastRecordingBound(video.currentTime, segment.endTime)) video.pause()
    }
    video.addEventListener('timeupdate', handleTimeUpdate)
    return () => video.removeEventListener('timeupdate', handleTimeUpdate)
  }, [segment])

  if (!segment) return <></>

  const goToIndex = (next: number): void => {
    if (next >= segments.length) {
      onClose()
      return
    }
    setIndex(Math.max(0, next))
  }

  const chooseVoice = (voiceId: string): void => {
    aiDubber.setSegmentVoice(segment.id, voiceId)
    goToIndex(index + 1)
  }

  const segmentState = aiDubber.getSegmentState(segment.id)

  // Catalog voices plus the user's own recorded ones -- this review is where
  // a character's voice actually gets decided, so a voice recorded FOR that
  // character has to be choosable here, not only in the Voice Model grid.
  const pickableVoices = [...VOICE_MODELS, ...savedVoices.map((v) => savedVoiceToModel(v, savedVoiceId(v.id)))]

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
              {videoSrc && <video ref={videoRef} src={videoSrc} className="detect-gender-video" />}
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

            <div className="detect-gender-voice-heading">
              <div>
                <strong>Choose a voice</strong>
                <span>Listen first, then select the closest match</span>
              </div>
              {segmentState.detectedGender !== 'unknown' && <span className="detect-gender-result-pill">Suggested: {segmentState.detectedGender}</span>}
            </div>
            <div className="detect-gender-voice-grid">
              {pickableVoices.map((voice) => {
                // The one voice actually assigned so far -- whether that came
                // from detectGenderForSegment's own real per-character pitch
                // recommendation (see voiceModels.ts) or a manual pick
                // revisited via Back. Exactly one button, never several.
                const selected = segmentState.voiceId === voice.id
                return (
                  <button
                    key={voice.id}
                    className={`detect-gender-voice-button${selected ? ' detect-gender-voice-button-selected' : ''}`}
                    onClick={() => chooseVoice(voice.id)}
                  >
                    <span className={`detect-gender-voice-avatar detect-gender-voice-avatar-${voice.gender}`}>{voice.avatarLetter}</span>
                    <span className="detect-gender-voice-copy">
                      <strong>{voice.name}</strong>
                      <small>{voice.description}</small>
                    </span>
                    {selected && <span className="detect-gender-suggested-badge">✓</span>}
                  </button>
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
