import { useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useSequence } from './SequenceContext'
import { useTimelineView } from '../timeline/TimelineViewContext'
import { useHistoryFieldProps } from '../history/useHistoryFieldProps'
import { parseDurationInput, MIN_CLIP_DURATION_SECONDS } from './sequenceOps'
import type { ClipTransform } from '@shared/project'

function formatSeconds(value: number): string {
  return value.toFixed(2)
}

const IDENTITY_TRANSFORM: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }

/** Properties for a selected real Timeline clip (V1/A1/A2) -- shown instead
 * of ScenePropertiesPanel (graphics) whenever a Timeline clip, not a Scene,
 * is selected. Editing duration numerically here updates the clip's width on
 * the Timeline immediately (both read from the same `sequence` state). */
export function ClipPropertiesPanel(): JSX.Element {
  const { items } = useMedia()
  const { sequence, selectedTimelineClipIds, toggleClipLock, toggleClipMute, moveClip, trimClip, updateClipProperties } = useSequence()
  const { linkageOn } = useTimelineView()
  const historyFieldProps = useHistoryFieldProps()
  const [durationText, setDurationText] = useState<string | null>(null)

  const clipId = selectedTimelineClipIds[0]
  const clip = clipId ? sequence.clips.find((c) => c.id === clipId) : undefined

  if (!clip) {
    return <p className="placeholder">Select a clip on a video/audio track to edit its properties.</p>
  }

  const track = sequence.tracks.find((t) => t.id === clip.trackId)
  const trackLabel = track ? `${track.id} ${track.name}` : clip.trackId
  const media = items.find((m) => m.id === clip.mediaId)
  const sourceDurationSeconds = media?.metadata?.durationSeconds
  const endTime = clip.startTime + clip.duration

  // No manual beginTransaction/endTransaction -- this is a single already-
  // atomic mutation (unlike a drag's many intermediate updates), so
  // HistoryContext's own snapshot-watch effect records it as one entry
  // automatically once React commits the state update.
  const commitTrim = (edge: 'left' | 'right', pointerTime: number): void => {
    trimClip(clip.id, edge, pointerTime, sourceDurationSeconds, { linked: linkageOn })
  }

  const applyDurationText = (): void => {
    if (durationText === null) return
    const parsed = parseDurationInput(durationText)
    setDurationText(null)
    if (parsed === null || parsed < MIN_CLIP_DURATION_SECONDS) return
    commitTrim('right', clip.startTime + parsed)
  }

  const transform = clip.transform ?? IDENTITY_TRANSFORM
  const setTransform = (patch: Partial<ClipTransform>): void => {
    updateClipProperties(clip.id, { transform: { ...transform, ...patch } })
  }
  const opacityPercent = Math.round((clip.opacity ?? 1) * 100)
  const volumePercent = Math.round((clip.volume ?? 1) * 100)
  const isVisual = clip.type === 'video' || clip.type === 'image'
  const hasAudioTrack = clip.type === 'video' || clip.type === 'audio'

  return (
    <div className="scene-properties">
      <div className="panel-fixed-head">
        <div className="scene-properties-header">
          <h3>Clip Properties</h3>
        </div>
        <p className="scene-properties-subtitle">{trackLabel}</p>
      </div>
      <div className="panel-scroll-body editor-scroll">
        <div className="scene-properties-group">
          <div className="scene-properties-group-title">Clip</div>
          <label className="scene-properties-field">
            Name
            <input type="text" value={media?.fileName ?? clip.mediaId} disabled readOnly />
          </label>
          <label className="scene-properties-field">
            Track
            <input type="text" value={trackLabel} disabled readOnly />
          </label>
        </div>

        <div className="scene-properties-group">
          <div className="scene-properties-group-title">Timing</div>
          <div className="scene-properties-row">
            <label className="scene-properties-field">
              Start time (s)
              <input
                type="number"
                min={0}
                step={0.1}
                disabled={clip.locked}
                value={formatSeconds(clip.startTime)}
                onChange={(e) => {
                  const value = Number(e.target.value)
                  if (Number.isFinite(value)) moveClip(clip.id, value, { linked: linkageOn })
                }}
                {...historyFieldProps}
              />
            </label>
            <label className="scene-properties-field">
              End time (s)
              <input type="text" value={formatSeconds(endTime)} disabled readOnly />
            </label>
          </div>
          <label className="scene-properties-field">
            Duration
            <input
              type="text"
              disabled={clip.locked}
              placeholder='e.g. "5s", "1m", "2m 30s"'
              value={durationText ?? formatSeconds(clip.duration) + 's'}
              onChange={(e) => setDurationText(e.target.value)}
              onBlur={applyDurationText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          </label>
          {clip.type !== 'image' && (
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Source In (s)
                <input type="text" value={formatSeconds(clip.sourceIn)} disabled readOnly />
              </label>
              <label className="scene-properties-field">
                Source Out (s)
                <input type="text" value={clip.sourceOut !== undefined ? formatSeconds(clip.sourceOut) : '—'} disabled readOnly />
              </label>
            </div>
          )}
        </div>

        <div className="scene-properties-group">
          <div className="scene-properties-group-title">State</div>
          <div className="scene-properties-row">
            <label className="scene-properties-checkbox-field">
              <input type="checkbox" checked={clip.locked} onChange={() => toggleClipLock(clip.id)} />
              Lock
            </label>
            {clip.type !== 'image' && (
              <label className="scene-properties-checkbox-field">
                <input type="checkbox" checked={Boolean(clip.muted)} disabled={clip.locked} onChange={() => toggleClipMute(clip.id)} />
                Mute
              </label>
            )}
          </div>
        </div>

        {isVisual && (
          <div className="scene-properties-group">
            <div className="scene-properties-group-title">Transform</div>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Position X (px)
                <input
                  type="number"
                  disabled={clip.locked}
                  value={transform.x}
                  onChange={(e) => Number.isFinite(Number(e.target.value)) && setTransform({ x: Number(e.target.value) })}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Position Y (px)
                <input
                  type="number"
                  disabled={clip.locked}
                  value={transform.y}
                  onChange={(e) => Number.isFinite(Number(e.target.value)) && setTransform({ y: Number(e.target.value) })}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Scale X
                <input
                  type="number"
                  step={0.05}
                  min={0.01}
                  disabled={clip.locked}
                  value={transform.scaleX}
                  onChange={(e) => Number(e.target.value) > 0 && setTransform({ scaleX: Number(e.target.value) })}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Scale Y
                <input
                  type="number"
                  step={0.05}
                  min={0.01}
                  disabled={clip.locked}
                  value={transform.scaleY}
                  onChange={(e) => Number(e.target.value) > 0 && setTransform({ scaleY: Number(e.target.value) })}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <label className="scene-properties-field">
              Rotation (°)
              <input
                type="number"
                disabled={clip.locked}
                value={transform.rotation}
                onChange={(e) => Number.isFinite(Number(e.target.value)) && setTransform({ rotation: Number(e.target.value) })}
                {...historyFieldProps}
              />
            </label>
            <div className="scene-properties-group-title">Crop (fraction of frame)</div>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Top
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  max={0.9}
                  disabled={clip.locked}
                  value={transform.cropTop}
                  onChange={(e) => setTransform({ cropTop: Math.min(0.9, Math.max(0, Number(e.target.value))) })}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Bottom
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  max={0.9}
                  disabled={clip.locked}
                  value={transform.cropBottom}
                  onChange={(e) => setTransform({ cropBottom: Math.min(0.9, Math.max(0, Number(e.target.value))) })}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Left
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  max={0.9}
                  disabled={clip.locked}
                  value={transform.cropLeft}
                  onChange={(e) => setTransform({ cropLeft: Math.min(0.9, Math.max(0, Number(e.target.value))) })}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Right
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  max={0.9}
                  disabled={clip.locked}
                  value={transform.cropRight}
                  onChange={(e) => setTransform({ cropRight: Math.min(0.9, Math.max(0, Number(e.target.value))) })}
                  {...historyFieldProps}
                />
              </label>
            </div>
            {transform !== IDENTITY_TRANSFORM && (
              <button className="scene-properties-reset-button" onClick={() => updateClipProperties(clip.id, { transform: IDENTITY_TRANSFORM })}>
                Reset Transform
              </button>
            )}
          </div>
        )}

        <div className="scene-properties-group">
          <div className="scene-properties-group-title">Opacity &amp; Speed</div>
          <label className="scene-properties-field">
            Opacity ({opacityPercent}%)
            <input
              type="range"
              min={0}
              max={100}
              disabled={clip.locked}
              value={opacityPercent}
              onChange={(e) => updateClipProperties(clip.id, { opacity: Number(e.target.value) / 100 })}
              {...historyFieldProps}
            />
          </label>
          {clip.type === 'video' && (
            <label className="scene-properties-field">
              Speed ({(clip.playbackRate ?? 1).toFixed(2)}x)
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                disabled={clip.locked}
                value={clip.playbackRate ?? 1}
                onChange={(e) => updateClipProperties(clip.id, { playbackRate: Number(e.target.value) })}
                {...historyFieldProps}
              />
            </label>
          )}
        </div>

        {hasAudioTrack && (
          <div className="scene-properties-group">
            <div className="scene-properties-group-title">Audio</div>
            <label className="scene-properties-field">
              Volume ({volumePercent}%)
              <input
                type="range"
                min={0}
                max={100}
                disabled={clip.locked || clip.muted}
                value={volumePercent}
                onChange={(e) => updateClipProperties(clip.id, { volume: Number(e.target.value) / 100 })}
                {...historyFieldProps}
              />
            </label>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Fade In (s)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  disabled={clip.locked}
                  value={clip.fadeIn ?? 0}
                  onChange={(e) => Number(e.target.value) >= 0 && updateClipProperties(clip.id, { fadeIn: Number(e.target.value) })}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Fade Out (s)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  disabled={clip.locked}
                  value={clip.fadeOut ?? 0}
                  onChange={(e) => Number(e.target.value) >= 0 && updateClipProperties(clip.id, { fadeOut: Number(e.target.value) })}
                  {...historyFieldProps}
                />
              </label>
            </div>
          </div>
        )}

        <p className="placeholder">Fit/Fill presets, reverse playback, preserve-pitch, pan, and loop are not yet available.</p>
      </div>
    </div>
  )
}
