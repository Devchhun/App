import { formatDuration } from '../media/format'
import { useNarration } from './NarrationContext'
import { timingStatus } from './narrationTiming'
import type { NarrationSpeaker } from '@shared/narration'

const COACHING_TIPS = ['Speak clearly', 'Match emotion', 'Finish before range end']

/** Right panel while Story Narration is active -- replaces the AI Suggestions
 * / Local AI / Story Visuals / Properties / Brand Preset tab system entirely
 * (App.tsx's RightSidebar). */
export function RecordingAssistantPanel(): JSX.Element {
  const narration = useNarration()
  const { currentSegment, currentSegmentIndex, segments, phase, mic, speakerDetecting } = narration

  if (!currentSegment) {
    return (
      <aside className="panel panel-brand narration-assistant">
        <div className="narration-assistant-title">
          Recording Assistant <span className="narration-info-icon" title="Story Narration Recording Assistant">ⓘ</span>
        </div>
        <p className="voiceover-story-hint">{segments.length === 0 ? 'Prepare a video and SRT on the left to begin.' : 'All segments have been accepted.'}</p>
      </aside>
    )
  }

  const targetDuration = currentSegment.endTime - currentSegment.startTime
  const timing = timingStatus(targetDuration, narration.elapsedSeconds)
  const timingIcon = timing.className === 'narration-timing-bad' ? '✗' : timing.className === 'narration-timing-warn' ? '⚠' : timing.className === 'narration-timing-good' ? '✓' : ''
  const segState = narration.currentSegmentState
  const hasTake = segState.takes.length > 0 || phase === 'reviewing'
  const isOvertime = phase === 'recording' && narration.elapsedSeconds > targetDuration
  const overtimeSeconds = narration.elapsedSeconds - targetDuration

  return (
    <aside className="panel panel-brand narration-assistant editor-scroll">
      <div className="narration-assistant-title">
        Recording Assistant <span className="narration-info-icon" title="Story Narration Recording Assistant">ⓘ</span>
      </div>

      {/* Position in the script, with the step controls on the same line as
          the count they step through, and a bar showing how far in you are
          -- "Segment 2 of 238" alone gives no sense of scale. */}
      <div className="narration-assistant-nav">
        <div className="narration-prev-next">
          <button disabled={currentSegmentIndex <= 0} onClick={narration.goToPreviousSegment} title="Previous segment">
            ◀
          </button>
          <button disabled={currentSegmentIndex >= segments.length - 1} onClick={narration.goToNextSegment} title="Next segment">
            ▶
          </button>
        </div>
        <span className="narration-assistant-nav-count">
          Segment <strong>{currentSegmentIndex + 1}</strong> of {segments.length}
        </span>
      </div>
      <div className="narration-assistant-progress">
        <span
          className="narration-assistant-progress-fill"
          style={{ width: `${segments.length > 0 ? ((currentSegmentIndex + 1) / segments.length) * 100 : 0}%` }}
        />
      </div>

      <div className="narration-current-card">
        <div className="narration-current-time">
          {formatDuration(currentSegment.startTime)} – {formatDuration(currentSegment.endTime)}
        </div>
        <div className="narration-current-text">{currentSegment.editedText ?? currentSegment.text}</div>
      </div>

      {/* Order follows the work: what to say (card above), the record
          control and its two play-backs right under it, then the setup
          choices (speaker, microphone) side by side, then the timing
          verdict and tips. */}
      <section className="narration-assistant-section">
        {phase === 'idle' && (
          <div className="narration-record-block">
            <button className="narration-record-circle" disabled={!mic.micReady} onClick={narration.startRecording} title="Record this segment (Shift+Space)">
              <span className="narration-record-circle-dot" />
            </button>
            <span className="narration-record-caption">Record · Shift+Space</span>
          </div>
        )}
        {phase === 'countdown' && (
          <div className="voiceover-recorder-countdown">
            <span>Starting in {narration.countdown}…</span>
            <button className="voiceover-recorder-cancel-button" onClick={narration.cancelCountdown}>
              Cancel
            </button>
          </div>
        )}
        {(phase === 'recording' || phase === 'reviewing') && (
          <div className={phase === 'recording' ? 'narration-recording-live narration-recording-live-active' : 'narration-recording-live'}>
            <div className="narration-recording-live-header">
              <button
                className="narration-record-circle narration-record-circle-active"
                onClick={phase === 'recording' ? narration.stopRecording : undefined}
                title={phase === 'recording' ? 'Stop recording (Shift+Space)' : undefined}
              >
                <span className="narration-record-circle-square" />
              </button>
              <div>
                <div className="narration-recording-live-label">{phase === 'recording' ? 'Recording…' : 'Recorded'}</div>
                <div className="narration-recording-live-timer">
                  {formatDuration(narration.elapsedSeconds)} / {formatDuration(targetDuration)}
                </div>
              </div>
              {isOvertime && <span className="narration-overtime-badge">+{overtimeSeconds.toFixed(1)}s over</span>}
            </div>
            <div className={isOvertime ? 'narration-waveform-track narration-waveform-track-over' : 'narration-waveform-track'}>
              <div
                className="narration-waveform-progress"
                style={{ width: `${Math.min(100, (narration.elapsedSeconds / Math.max(targetDuration, 0.1)) * 100)}%` }}
              >
                <span className="narration-waveform-marker" />
              </div>
            </div>
            <div className="narration-waveform-times">
              <span>00:00</span>
              <span className={isOvertime ? 'narration-waveform-time-over' : undefined}>
                {isOvertime ? `goal ${targetDuration.toFixed(2)}s` : `${targetDuration.toFixed(2)}s`}
              </span>
            </div>
          </div>
        )}
        {phase === 'reviewing' && (
          <div className="narration-review-actions">
            <button className="voiceover-recorder-cancel-button" onClick={narration.redoTake} title="Discard this take and record again (Backspace)">
              Redo
            </button>
            <button className="voiceover-recorder-record-button" onClick={narration.acceptTake}>
              Accept & Next ✓
            </button>
          </div>
        )}
      </section>

      <div className="narration-review-buttons">
        <button onClick={narration.playOriginal}>▷ Play Original</button>
        <button disabled={!hasTake} onClick={narration.playTake}>
          🔊 Play My Take
        </button>
      </div>
      {/* Always mounted (not just while reviewing) so `reviewAudioRef` is
          available for playTake() to also play an ALREADY-ACCEPTED
          segment's own real take -- src is set imperatively there rather
          than via this JSX attribute, which would only ever cover the
          in-memory not-yet-accepted case. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a recorded voice take being reviewed/replayed, not user-facing content needing captions. */}
      <audio ref={narration.reviewAudioRef} />

      <div className="narration-assistant-grid">
      <section className="narration-assistant-section">
        {/* Label sits on the row with its control rather than on a line of
            its own -- the panel stacks five of these, and five extra
            uppercase heading rows was most of its vertical budget. */}
        <div className="narration-assistant-row">
          <span className="narration-assistant-row-label" title="Estimated from the original video's own audio pitch, not the subtitle text">
            Speaker
          </span>
        </div>
        <div className="narration-speaker-buttons">
          <div className="narration-speaker-switch" role="group" aria-label="Speaker">
            {(['male', 'female'] as NarrationSpeaker[]).map((s) => (
              <button
                key={s}
                className={segState.speakerManualOverride && segState.speaker === s ? 'narration-speaker-button narration-speaker-button-active' : 'narration-speaker-button'}
                onClick={() => narration.setSpeakerOverride(currentSegment.id, s)}
              >
                {s === 'male' ? 'Male' : 'Female'}
              </button>
            ))}
            <button
              className={!segState.speakerManualOverride ? 'narration-speaker-button narration-speaker-button-active' : 'narration-speaker-button'}
              title="Detect automatically from audio pitch"
              onClick={() => narration.clearSpeakerOverride(currentSegment.id)}
            >
              Auto
            </button>
          </div>
          {speakerDetecting && <span className="narration-confidence-badge narration-confidence-badge-detecting">Detecting…</span>}
          {/* One segment of the switch is "on" at a time: a manual pick, or
              Auto -- whose result then reads in the badge beside it. */}
          {!speakerDetecting && segState.speakerConfidence !== undefined && !segState.speakerManualOverride && (
            <span className="narration-confidence-badge">
              {segState.speaker === 'male' ? 'Male' : segState.speaker === 'female' ? 'Female' : '?'} {Math.round(segState.speakerConfidence * 100)}%
            </span>
          )}
          {!speakerDetecting && segState.speakerConfidence === undefined && !segState.speakerManualOverride && segState.speaker === 'unknown' && (
            <span className="narration-confidence-badge narration-confidence-badge-unknown">Unknown</span>
          )}
        </div>
      </section>
      <section className="narration-assistant-section">
        <div className="narration-assistant-row">
          <span className="narration-assistant-row-label">Microphone</span>
        </div>
        <div className="voiceover-recorder-device-row">
          <select className="voiceover-recorder-device-select" value={mic.selectedDeviceId} disabled={phase !== 'idle'} onChange={(e) => mic.selectDevice(e.target.value)}>
            {mic.devices.length === 0 && <option value="">Default microphone</option>}
            {mic.devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </select>
        </div>
        <div className="voiceover-recorder-level-track">
          <div className="voiceover-recorder-level-bar" ref={mic.levelBarRef} />
        </div>
        {mic.error && <div className="voiceover-recorder-error">{mic.error}</div>}
      </section>
      </div>

      <section className="narration-assistant-section">
        <div className="narration-timing-row">
          <div className="narration-timing-values">
            <span>
              Target<br />
              <strong>{targetDuration.toFixed(1)}s</strong>
            </span>
            <span>
              Your take<br />
              <strong className={timing.className ? `narration-timing-value-${timing.className.replace('narration-timing-', '')}` : undefined}>
                {narration.elapsedSeconds > 0 ? `${narration.elapsedSeconds.toFixed(1)}s` : '—'}
              </strong>
            </span>
          </div>
          {/* Own line rather than squeezed into the row beside the two
              numbers above -- "Exceeds subtitle range by 139.1s" is long
              enough that sharing a `justify-content: space-between` row with
              two other items either overlapped them or forced an ugly wrap
              mid-badge in this panel's width. */}
          {timing.label !== '—' && <span className={`narration-timing-status ${timing.className}`}>{timingIcon && `${timingIcon} `}{timing.label}</span>}
        </div>
      </section>

      <section className="narration-assistant-section">
        <div className="narration-assistant-row">
          <span className="narration-assistant-row-label">Coaching Tips</span>
        </div>
        <div className="narration-coaching-tips">
          {COACHING_TIPS.map((tip) => (
            <span key={tip} className="narration-coaching-tip">
              ✓ {tip}
            </span>
          ))}
        </div>
      </section>
    </aside>
  )
}
