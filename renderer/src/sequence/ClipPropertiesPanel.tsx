import { REMOVE_BACKGROUND_EVENT } from '../media/removeBackgroundEvent'
import { MotionPicker } from './MotionPicker'
import { useState, type ReactNode } from 'react'
import { useMedia } from '../media/MediaContext'
import { useSequence } from './SequenceContext'
import { usePlaybackTime } from '../playback/PlaybackContext'
import { useTimelineView } from '../timeline/TimelineViewContext'
import { useHistoryFieldProps } from '../history/useHistoryFieldProps'
import { parseDurationInput, MIN_CLIP_DURATION_SECONDS } from './sequenceOps'
import { RotateIcon, ChevronDownIcon } from '../nav/icons'
import { MAX_CLIP_VOLUME } from '../media/audioBoost'
import { useAudioEffects } from '../audioFx/AudioEffectsContext'
import { AUDIO_EFFECT_PRESETS, createDefaultAudioEffectSettings, type AudioEffectSettings } from '@shared/audioEffects'
import type { ClipTransform, TimelineClip } from '@shared/project'
import type { KeyframeableProperty } from '@shared/keyframes'

function formatSeconds(value: number): string {
  return value.toFixed(2)
}

const IDENTITY_TRANSFORM: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }

const KEYFRAME_TIME_EPSILON = 0.001

/** Keyframe Animation's ◇/◆ toggle, shown beside a property's own label.
 * ◇ (empty) = not keyframed, or keyframed but the playhead isn't sitting on
 * one of its points right now; ◆ (filled) = a keyframe exists at the exact
 * current playhead position. Clicking it adds/updates a keyframe at the
 * playhead with the field's CURRENT value, or -- if one already sits
 * exactly there -- removes it (a simple add/remove toggle, not a separate
 * "delete" affordance for this common case; deleting a keyframe elsewhere
 * in time is done via its diamond marker's own context menu on the
 * Timeline). Whichever property was most recently clicked becomes the one
 * shown as diamond markers on the clip's own Timeline body (see
 * TimelineViewContext's `activeKeyframeProperty`). */
function KeyframeToggle({ clip, property, value, timeInClip }: { clip: TimelineClip; property: KeyframeableProperty; value: number; timeInClip: number }): JSX.Element {
  const { addOrUpdateKeyframe, removeKeyframe } = useSequence()
  const { activeKeyframeProperty, setActiveKeyframeProperty } = useTimelineView()
  const keyframes = clip.keyframes?.[property] ?? []
  const isKeyframed = keyframes.length > 0
  const exactMatch = keyframes.find((k) => Math.abs(k.time - timeInClip) < KEYFRAME_TIME_EPSILON)
  const isViewing = activeKeyframeProperty === property

  return (
    <button
      type="button"
      className={`keyframe-toggle${isKeyframed ? ' keyframe-toggle-keyframed' : ''}${isViewing ? ' keyframe-toggle-viewing' : ''}`}
      disabled={clip.locked}
      onClick={() => {
        setActiveKeyframeProperty(property)
        if (exactMatch) removeKeyframe(clip.id, property, exactMatch.id)
        else addOrUpdateKeyframe(clip.id, property, timeInClip, value)
      }}
      title={exactMatch ? 'Remove keyframe at playhead' : isKeyframed ? 'Add/update a keyframe here at the playhead' : 'Keyframe this property, starting at the playhead'}
    >
      {exactMatch ? '◆' : '◇'}
    </button>
  )
}

/* ---------- layout primitives (CapCut-style inspector) ---------- */

/** One collapsible block: a bold title with a caret, an optional reset
 * arrow on the right, and its rows underneath. Sections remember their own
 * open state; `defaultOpen: false` is for the rarely-touched ones (Timing,
 * Info) so the first screen is the controls people actually reach for. */
function Section({
  title,
  defaultOpen = true,
  onReset,
  resetTitle = 'Reset',
  children
}: {
  title: string
  defaultOpen?: boolean
  onReset?: () => void
  resetTitle?: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={open ? 'cp-section cp-section-open' : 'cp-section'}>
      <div className="cp-section-head">
        <button type="button" className="cp-section-title" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {title}
          <ChevronDownIcon size={11} />
        </button>
        {onReset && (
          <button type="button" className="cp-icon-btn" title={resetTitle} onClick={onReset}>
            <RotateIcon size={14} />
          </button>
        )}
      </div>
      {open && <div className="cp-section-body">{children}</div>}
    </section>
  )
}

/** Label on the left, control(s) on the right -- the inspector's one row
 * shape, so every section lines up on the same two columns. */
function Row({ label, keyframe, children }: { label: ReactNode; keyframe?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="cp-row">
      <div className="cp-label">
        {label}
        {keyframe}
      </div>
      <div className="cp-control">{children}</div>
    </div>
  )
}

/** Number field with a trailing unit (%, °, s, px). Native spinners give
 * the ▲▼ stepper for free. */
function NumberField({
  value,
  onChange,
  unit,
  step = 1,
  min,
  max,
  disabled,
  digits = 0,
  title
}: {
  value: number
  onChange: (next: number) => void
  unit?: string
  step?: number
  min?: number
  max?: number
  disabled?: boolean
  digits?: number
  title?: string
}): JSX.Element {
  const history = useHistoryFieldProps()
  // Free typing, committed on blur/Enter: while the field holds a partial
  // number ("1." or "-") it must not be snapped back by a re-render.
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (Number.isInteger(value) && digits === 0 ? String(value) : value.toFixed(digits))
  const commit = (): void => {
    if (draft === null) return
    const n = Number(draft)
    setDraft(null)
    if (!Number.isFinite(n)) return
    let next = n
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    onChange(next)
  }
  return (
    <span className={unit ? 'cp-num cp-num-unit' : 'cp-num'} data-unit={unit} title={title}>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          // Spinner clicks and whole numbers apply live; only partial
          // text waits for blur.
          if (e.target.value !== '' && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(e.target.value)) {
            let next = n
            if (min !== undefined) next = Math.max(min, next)
            if (max !== undefined) next = Math.min(max, next)
            onChange(next)
          }
        }}
        onFocus={history.onFocus}
        onBlur={() => {
          commit()
          history.onBlur()
        }}
        onKeyDown={history.onKeyDown}
      />
    </span>
  )
}

function Slider({ value, onChange, min, max, step = 1, disabled }: { value: number; onChange: (next: number) => void; min: number; max: number; step?: number; disabled?: boolean }): JSX.Element {
  const history = useHistoryFieldProps()
  const pct = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      className="cp-slider"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={value}
      style={{ '--fill': `${pct}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
      onFocus={history.onFocus}
      onBlur={history.onBlur}
    />
  )
}

/** The speeds CapCut offers as one-click chips; the slider covers the rest. */
const SPEED_PRESETS = [0.5, 0.75, 1, 1.5, 2] as const

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={checked ? 'cp-switch cp-switch-on' : 'cp-switch'} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="cp-switch-knob" />
    </button>
  )
}

/* Six alignment glyphs: a bar on one edge/centre plus a block. */
const ALIGN_GLYPHS = {
  left: 'M3 3v14M6 6h8v3H6zM6 11h5v3H6z',
  hcenter: 'M10 3v14M5 6h10v3H5zM7 11h6v3H7z',
  right: 'M17 3v14M6 6h8v3H6zM9 11h5v3H9z',
  top: 'M3 3h14M6 6h3v8H6zM11 6h3v5h-3z',
  vcenter: 'M3 10h14M6 5h3v10H6zM11 7h3v6h-3z',
  bottom: 'M3 17h14M6 6h3v8H6zM11 9h3v5h-3z'
} as const
type Align = keyof typeof ALIGN_GLYPHS

function AlignIcon({ kind }: { kind: Align }): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="currentColor" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
      <path d={ALIGN_GLYPHS[kind]} />
    </svg>
  )
}

/** The picture's box on the live preview stage, for edge alignment: the
 * element fills the stage (translate is in stage px, scale about the
 * centre), so "align left" means shifting it by half of whatever the scale
 * took off its width. Reads the stage from the DOM -- PreviewPlayer owns
 * the size and nothing else needs it. */
function stageSizePx(): { width: number; height: number } | null {
  const el = document.querySelector('.preview-stage')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null
}

/* ---------- the panel ---------- */

/** Properties for a selected real Timeline clip (V1/A1/A2) -- shown instead
 * of ScenePropertiesPanel (graphics) whenever a Timeline clip, not a Scene,
 * is selected. Laid out as a CapCut-style inspector: a tab strip for the
 * clip kind, then collapsible sections (Transform, Blend, Crop, Speed,
 * Audio, Timing, Info) of label | control rows. Editing duration
 * numerically here updates the clip's width on the Timeline immediately
 * (both read from the same `sequence` state). */
/** Audio Effects for an audio clip: a preset with an amount, bass and
 * treble -- rendered into the clip (AudioEffectsContext), so the Player and
 * Export hear the same. Apply to this clip, or to every audio clip on its
 * track (all the dubbed lines on DUB1, say). */
function AudioEffectsSection({ clip, trackName, trackClipIds, locked }: { clip: TimelineClip; trackName: string; trackClipIds: string[]; locked: boolean }): JSX.Element {
  const { applyAudioEffect, progress } = useAudioEffects()
  const [draft, setDraft] = useState<AudioEffectSettings>(() => clip.audioEffect?.settings ?? createDefaultAudioEffectSettings())
  const [note, setNote] = useState<string | null>(null)
  const busy = progress !== null
  const run = async (ids: string[], settings: AudioEffectSettings): Promise<void> => {
    setNote(null)
    const { done, failed } = await applyAudioEffect(ids, settings)
    setNote(failed > 0 ? `${done} clip(s) done, ${failed} failed` : `${done} clip(s) done`)
  }
  const set = (patch: Partial<AudioEffectSettings>): void => setDraft((d) => ({ ...d, ...patch }))
  return (
    <Section title="Audio Effects" resetTitle="Remove the effect" onReset={() => void run([clip.id], createDefaultAudioEffectSettings())}>
      <div className="cp-fx-presets">
        {AUDIO_EFFECT_PRESETS.map((p) => (
          <button
            key={p.id}
            className={draft.preset === p.id ? 'cp-fx-preset cp-fx-preset-active' : 'cp-fx-preset'}
            title={p.hint}
            disabled={locked || busy}
            onClick={() => set({ preset: p.id })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Row label="Amount">
        <input className="cp-fx-range" type="range" min={0} max={100} step={5} value={draft.amount} disabled={locked || busy || draft.preset === 'none'} onChange={(e) => set({ amount: Number(e.target.value) })} />
        <span className="cp-fx-value">{draft.amount}%</span>
      </Row>
      <Row label="Bass">
        <input className="cp-fx-range" type="range" min={-12} max={12} step={1} value={draft.bassDb} disabled={locked || busy} onChange={(e) => set({ bassDb: Number(e.target.value) })} />
        <span className="cp-fx-value">{draft.bassDb > 0 ? '+' : ''}{draft.bassDb} dB</span>
      </Row>
      <Row label="Treble">
        <input className="cp-fx-range" type="range" min={-12} max={12} step={1} value={draft.trebleDb} disabled={locked || busy} onChange={(e) => set({ trebleDb: Number(e.target.value) })} />
        <span className="cp-fx-value">{draft.trebleDb > 0 ? '+' : ''}{draft.trebleDb} dB</span>
      </Row>
      <div className="cp-fx-actions">
        <button className="cp-fx-apply" disabled={locked || busy} onClick={() => void run([clip.id], draft)}>
          Apply
        </button>
        <button className="cp-fx-apply cp-fx-apply-all" disabled={busy || trackClipIds.length === 0} title={`The same effect on all ${trackClipIds.length} audio clip(s) on ${trackName}`} onClick={() => void run(trackClipIds, draft)}>
          Apply to all audio on {trackName} ({trackClipIds.length})
        </button>
      </div>
      {busy && <div className="cp-speed-note">Rendering {progress.done} / {progress.total}…</div>}
      {!busy && note && <div className="cp-speed-note">{note}</div>}
      {clip.audioEffect && !busy && (
        <div className="cp-speed-note">
          This clip has: {AUDIO_EFFECT_PRESETS.find((p) => p.id === clip.audioEffect!.settings.preset)?.label ?? 'EQ'} · the original sound is kept (Reset removes the effect).
        </div>
      )}
    </Section>
  )
}

export function ClipPropertiesPanel(): JSX.Element {
  const { items } = useMedia()
  const { sequence, selectedTimelineClipIds, toggleClipLock, toggleClipMute, moveClip, trimClip, updateClipProperties } = useSequence()
  const { currentTime } = usePlaybackTime()
  const [tab, setTab] = useState<'basic' | 'animation'>('basic')
  const { linkageOn } = useTimelineView()
  const historyFieldProps = useHistoryFieldProps()
  const [durationText, setDurationText] = useState<string | null>(null)
  // "Uniform scale" is a panel-side convenience (one slider drives both
  // axes), not a clip property: it starts on unless the clip already has
  // unequal axes, and nothing is stored for it.
  const [uniformPref, setUniformPref] = useState<boolean | null>(null)

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
  const locked = clip.locked

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
  const uniform = uniformPref ?? Math.abs(transform.scaleX - transform.scaleY) < 1e-6
  const scalePercent = Math.round(transform.scaleX * 100)
  const setScalePercent = (pct: number, axis?: 'scaleX' | 'scaleY'): void => {
    const v = Math.max(0.01, pct / 100)
    if (axis && !uniform) setTransform({ [axis]: v })
    else setTransform({ scaleX: v, scaleY: v })
  }

  const align = (kind: Align): void => {
    const stage = stageSizePx()
    if (!stage) return
    const dx = (stage.width * (1 - transform.scaleX)) / 2
    const dy = (stage.height * (1 - transform.scaleY)) / 2
    switch (kind) {
      case 'left':
        return setTransform({ x: -dx })
      case 'hcenter':
        return setTransform({ x: 0 })
      case 'right':
        return setTransform({ x: dx })
      case 'top':
        return setTransform({ y: -dy })
      case 'vcenter':
        return setTransform({ y: 0 })
      case 'bottom':
        return setTransform({ y: dy })
    }
  }

  const opacityPercent = Math.round((clip.opacity ?? 1) * 100)
  const volumePercent = Math.round((clip.volume ?? 1) * 100)
  const isVisual = clip.type === 'video' || clip.type === 'image'
  const hasAudioTrack = clip.type === 'video' || clip.type === 'audio'
  const playbackRate = clip.playbackRate ?? 1
  const linkedPartner = clip.linkedClipId ? sequence.clips.find((c) => c.id === clip.linkedClipId) : undefined
  const kindLabel = clip.type === 'image' ? 'Image' : clip.type === 'video' ? 'Video' : 'Audio'
  // Where a new/updated keyframe lands -- ClipKeyframe.time is relative to
  // the CLIP's own start, clamped to its duration (matching addClipMarker's
  // own clamping convention for the exact same reason: a keyframe can't
  // exist outside the clip it belongs to).
  const timeInClip = Math.max(0, Math.min(clip.duration, currentTime - clip.startTime))

  const cropPct = (v: number): number => Math.round(v * 100)
  const setCrop = (key: 'cropTop' | 'cropRight' | 'cropBottom' | 'cropLeft', pct: number): void => {
    setTransform({ [key]: Math.min(0.9, Math.max(0, pct / 100)) })
  }
  const hasCrop = transform.cropTop || transform.cropRight || transform.cropBottom || transform.cropLeft

  return (
    <div className="scene-properties cp-panel">
      <div className="panel-fixed-head">
        <div className="cp-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'basic'} className={tab === 'basic' ? 'cp-tab cp-tab-active' : 'cp-tab'} onClick={() => setTab('basic')}>
            {kindLabel}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'animation'}
            className={tab === 'animation' ? 'cp-tab cp-tab-active' : 'cp-tab'}
            disabled={!isVisual}
            title={isVisual ? 'Motion: float, bounce, wander around the screen…' : 'For pictures (video and images)'}
            onClick={() => setTab('animation')}
          >
            Animation
          </button>
          {isVisual && (
            <button type="button" role="tab" className="cp-tab" disabled title="Coming soon">
              Adjustment
            </button>
          )}
        </div>
      </div>
      {tab === 'animation' && isVisual && (
        <div className="panel-scroll-body editor-scroll cp-body">
          <Section title="Motion" resetTitle="No motion" onReset={() => updateClipProperties(clip.id, { motion: undefined })}>
            <MotionPicker motion={clip.motion} disabled={locked} onChange={(motion) => updateClipProperties(clip.id, { motion })} />
          </Section>
        </div>
      )}
      <div className="panel-scroll-body editor-scroll cp-body" hidden={tab === 'animation' && isVisual}>
        {isVisual && (
          <Section
            title="Transform"
            resetTitle="Reset transform"
            onReset={() => setTransform({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 })}
          >
            <Row label="Scale" keyframe={<KeyframeToggle clip={clip} property="scaleX" value={transform.scaleX} timeInClip={timeInClip} />}>
              <Slider min={1} max={400} value={scalePercent} disabled={locked} onChange={(v) => setScalePercent(v, 'scaleX')} />
              <NumberField value={scalePercent} unit="%" min={1} max={1000} disabled={locked} onChange={(v) => setScalePercent(v, 'scaleX')} />
            </Row>
            {!uniform && (
              <Row label="Scale Y" keyframe={<KeyframeToggle clip={clip} property="scaleY" value={transform.scaleY} timeInClip={timeInClip} />}>
                <Slider min={1} max={400} value={Math.round(transform.scaleY * 100)} disabled={locked} onChange={(v) => setScalePercent(v, 'scaleY')} />
                <NumberField value={Math.round(transform.scaleY * 100)} unit="%" min={1} max={1000} disabled={locked} onChange={(v) => setScalePercent(v, 'scaleY')} />
              </Row>
            )}
            <Row label="Uniform scale">
              <Switch
                label="Uniform scale"
                checked={uniform}
                disabled={locked}
                onChange={(next) => {
                  setUniformPref(next)
                  if (next) setTransform({ scaleY: transform.scaleX })
                }}
              />
            </Row>
            <Row label="Position">
              <span className="cp-axis">
                <span className="cp-axis-name">X</span>
                <NumberField value={Math.round(transform.x)} disabled={locked} onChange={(v) => setTransform({ x: v })} />
                <KeyframeToggle clip={clip} property="x" value={transform.x} timeInClip={timeInClip} />
              </span>
              <span className="cp-axis">
                <span className="cp-axis-name">Y</span>
                <NumberField value={Math.round(transform.y)} disabled={locked} onChange={(v) => setTransform({ y: v })} />
                <KeyframeToggle clip={clip} property="y" value={transform.y} timeInClip={timeInClip} />
              </span>
            </Row>
            <Row label="Rotate" keyframe={<KeyframeToggle clip={clip} property="rotation" value={transform.rotation} timeInClip={timeInClip} />}>
              <NumberField value={transform.rotation} unit="°" digits={1} step={1} disabled={locked} onChange={(v) => setTransform({ rotation: v })} />
              <button type="button" className="cp-icon-btn cp-icon-btn-round" title="Reset rotation" disabled={locked} onClick={() => setTransform({ rotation: 0 })}>
                <RotateIcon size={12} />
              </button>
            </Row>
            <div className="cp-align-row" role="group" aria-label="Align in frame">
              {(['left', 'hcenter', 'right'] as Align[]).map((k) => (
                <button key={k} type="button" className="cp-align-btn" disabled={locked} title={k === 'left' ? 'Align left' : k === 'right' ? 'Align right' : 'Center horizontally'} onClick={() => align(k)}>
                  <AlignIcon kind={k} />
                </button>
              ))}
              <span className="cp-align-sep" />
              {(['top', 'vcenter', 'bottom'] as Align[]).map((k) => (
                <button key={k} type="button" className="cp-align-btn" disabled={locked} title={k === 'top' ? 'Align top' : k === 'bottom' ? 'Align bottom' : 'Center vertically'} onClick={() => align(k)}>
                  <AlignIcon kind={k} />
                </button>
              ))}
            </div>
          </Section>
        )}

        {clip.type === 'image' && (
          <Section title="Background">
            <div className="cp-bg-remove">
              <button type="button" className="cp-bg-remove-button" disabled={locked} onClick={() => window.dispatchEvent(new CustomEvent(REMOVE_BACKGROUND_EVENT, { detail: clip.id }))}>
                Remove Background
              </button>
              <span className="cp-bg-remove-note">AI cuts out the subject (a logo, a person) and makes the rest see-through. The first time downloads its model (~180 MB).</span>
            </div>
          </Section>
        )}
        {isVisual && (
          <Section title="Blend" resetTitle="Reset opacity" onReset={() => updateClipProperties(clip.id, { opacity: 1 })}>
            <Row label="Opacity" keyframe={<KeyframeToggle clip={clip} property="opacity" value={clip.opacity ?? 1} timeInClip={timeInClip} />}>
              <Slider min={0} max={100} value={opacityPercent} disabled={locked} onChange={(v) => updateClipProperties(clip.id, { opacity: v / 100 })} />
              <NumberField value={opacityPercent} unit="%" min={0} max={100} disabled={locked} onChange={(v) => updateClipProperties(clip.id, { opacity: v / 100 })} />
            </Row>
          </Section>
        )}

        {isVisual && (
          <Section
            title="Crop"
            defaultOpen={Boolean(hasCrop)}
            resetTitle="Reset crop"
            onReset={() => setTransform({ cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 })}
          >
            <Row label="Top" keyframe={<KeyframeToggle clip={clip} property="cropTop" value={transform.cropTop} timeInClip={timeInClip} />}>
              <Slider min={0} max={90} value={cropPct(transform.cropTop)} disabled={locked} onChange={(v) => setCrop('cropTop', v)} />
              <NumberField value={cropPct(transform.cropTop)} unit="%" min={0} max={90} disabled={locked} onChange={(v) => setCrop('cropTop', v)} />
            </Row>
            <Row label="Bottom" keyframe={<KeyframeToggle clip={clip} property="cropBottom" value={transform.cropBottom} timeInClip={timeInClip} />}>
              <Slider min={0} max={90} value={cropPct(transform.cropBottom)} disabled={locked} onChange={(v) => setCrop('cropBottom', v)} />
              <NumberField value={cropPct(transform.cropBottom)} unit="%" min={0} max={90} disabled={locked} onChange={(v) => setCrop('cropBottom', v)} />
            </Row>
            <Row label="Left" keyframe={<KeyframeToggle clip={clip} property="cropLeft" value={transform.cropLeft} timeInClip={timeInClip} />}>
              <Slider min={0} max={90} value={cropPct(transform.cropLeft)} disabled={locked} onChange={(v) => setCrop('cropLeft', v)} />
              <NumberField value={cropPct(transform.cropLeft)} unit="%" min={0} max={90} disabled={locked} onChange={(v) => setCrop('cropLeft', v)} />
            </Row>
            <Row label="Right" keyframe={<KeyframeToggle clip={clip} property="cropRight" value={transform.cropRight} timeInClip={timeInClip} />}>
              <Slider min={0} max={90} value={cropPct(transform.cropRight)} disabled={locked} onChange={(v) => setCrop('cropRight', v)} />
              <NumberField value={cropPct(transform.cropRight)} unit="%" min={0} max={90} disabled={locked} onChange={(v) => setCrop('cropRight', v)} />
            </Row>
          </Section>
        )}

        {/* Speed is for anything with a timeline of its own: video, plain
            audio, and generated narration/dub clips alike. A clip that is
            linked to a partner (a video and its own audio) always retimes
            with it, so picture and sound never drift apart -- the note
            below says so, and the retiming itself is in sequenceOps'
            applyClipProperties. */}
        {clip.type !== 'image' && (
          <Section title="Speed" resetTitle="Reset speed" onReset={() => updateClipProperties(clip.id, { playbackRate: 1 })}>
            <Row label="Speed">
              <Slider min={0.25} max={4} step={0.05} value={playbackRate} disabled={locked} onChange={(v) => updateClipProperties(clip.id, { playbackRate: v })} />
              <NumberField value={playbackRate} unit="x" digits={2} step={0.05} min={0.25} max={4} disabled={locked} onChange={(v) => updateClipProperties(clip.id, { playbackRate: v })} />
            </Row>
            <Row label="Presets">
              <div className="cp-speed-presets">
                {SPEED_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={Math.abs(playbackRate - preset) < 0.001 ? 'cp-speed-preset cp-speed-preset-active' : 'cp-speed-preset'}
                    disabled={locked}
                    onClick={() => updateClipProperties(clip.id, { playbackRate: preset })}
                  >
                    {preset === 1 ? '1x' : `${preset}x`}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="New length">
              <span className="cp-readout">
                {formatSeconds(clip.duration)} s{playbackRate !== 1 ? ` · was ${formatSeconds(clip.duration * playbackRate)} s at 1x` : ''}
              </span>
            </Row>
            {linkedPartner && (
              <div className="cp-speed-note">
                {linkedPartner.type === 'audio' ? 'Its audio changes by the same amount.' : 'Its video changes by the same amount.'}
              </div>
            )}
          </Section>
        )}

        {hasAudioTrack && (
          <Section title="Audio" resetTitle="Reset audio" onReset={() => updateClipProperties(clip.id, { volume: 1, fadeIn: 0, fadeOut: 0 })}>
            <Row label="Volume" keyframe={<KeyframeToggle clip={clip} property="volume" value={clip.volume ?? 1} timeInClip={timeInClip} />}>
              {/* Up to 300%: a quiet source (the video's own sound) can be made louder. */}
              <Slider min={0} max={MAX_CLIP_VOLUME * 100} value={volumePercent} disabled={locked || Boolean(clip.muted)} onChange={(v) => updateClipProperties(clip.id, { volume: v / 100 })} />
              <NumberField value={volumePercent} unit="%" min={0} max={MAX_CLIP_VOLUME * 100} disabled={locked || Boolean(clip.muted)} onChange={(v) => updateClipProperties(clip.id, { volume: v / 100 })} />
            </Row>
            <Row label="Mute">
              <Switch label="Mute" checked={Boolean(clip.muted)} disabled={locked} onChange={() => toggleClipMute(clip.id)} />
            </Row>
            <Row label="Fade in">
              <NumberField value={clip.fadeIn ?? 0} unit="s" digits={1} step={0.1} min={0} disabled={locked} onChange={(v) => updateClipProperties(clip.id, { fadeIn: v })} />
            </Row>
            <Row label="Fade out">
              <NumberField value={clip.fadeOut ?? 0} unit="s" digits={1} step={0.1} min={0} disabled={locked} onChange={(v) => updateClipProperties(clip.id, { fadeOut: v })} />
            </Row>
          </Section>
        )}

        {clip.type === 'audio' && (
          <AudioEffectsSection
            key={clip.id}
            clip={clip}
            locked={locked}
            trackName={sequence.tracks.find((t) => t.id === clip.trackId)?.name ?? clip.trackId}
            trackClipIds={sequence.clips.filter((c) => c.trackId === clip.trackId && c.type === 'audio' && !c.locked).map((c) => c.id)}
          />
        )}

        <Section title="Timing" defaultOpen={false}>
          <Row label="Start">
            <NumberField value={clip.startTime} unit="s" digits={2} step={0.1} min={0} disabled={locked} onChange={(v) => moveClip(clip.id, v, { linked: linkageOn })} />
          </Row>
          <Row label="End">
            <span className="cp-readout">{formatSeconds(endTime)} s</span>
          </Row>
          <Row label="Duration">
            <input
              className="cp-text"
              type="text"
              disabled={locked}
              placeholder='e.g. "5s", "1m", "2m 30s"'
              value={durationText ?? formatSeconds(clip.duration) + 's'}
              onChange={(e) => setDurationText(e.target.value)}
              onFocus={historyFieldProps.onFocus}
              onBlur={() => {
                applyDurationText()
                historyFieldProps.onBlur()
              }}
              onKeyDown={historyFieldProps.onKeyDown}
            />
          </Row>
          {clip.type !== 'image' && (
            <Row label="Source">
              <span className="cp-readout">
                {formatSeconds(clip.sourceIn)} s → {clip.sourceOut !== undefined ? `${formatSeconds(clip.sourceOut)} s` : '—'}
              </span>
            </Row>
          )}
        </Section>

        <Section title="Info" defaultOpen={false}>
          <Row label="Name">
            <span className="cp-readout cp-readout-ellipsis" title={media?.fileName ?? clip.mediaId}>
              {media?.fileName ?? clip.mediaId}
            </span>
          </Row>
          <Row label="Track">
            <span className="cp-readout">{trackLabel}</span>
          </Row>
          <Row label="Lock">
            <Switch label="Lock clip" checked={locked} onChange={() => toggleClipLock(clip.id)} />
          </Row>
        </Section>
      </div>
    </div>
  )
}
