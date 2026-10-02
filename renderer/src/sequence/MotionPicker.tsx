import { CLIP_MOTION_HINTS, CLIP_MOTION_LABELS, CLIP_MOTION_PRESETS, DEFAULT_CLIP_MOTION_AMOUNT, DEFAULT_CLIP_MOTION_SPEED, type ClipMotion, type ClipMotionPreset } from '@shared/clipMotion'

/** Clip Properties > Animation: a looping motion for the clip's picture --
 * a logo that floats, bounces, wanders around the screen... Each card
 * shows its own motion; the Player and the export both play it
 * (shared/clipMotion.ts). */
export function MotionPicker({ motion, disabled, onChange }: { motion: ClipMotion | undefined; disabled: boolean; onChange: (next: ClipMotion | undefined) => void }): JSX.Element {
  const pick = (preset: ClipMotionPreset): void =>
    onChange({ preset, speed: motion?.speed ?? DEFAULT_CLIP_MOTION_SPEED, amount: motion?.amount ?? (preset === 'wander' ? 1 : DEFAULT_CLIP_MOTION_AMOUNT) })
  return (
    <div className="motion-picker">
      <div className="motion-picker-grid" role="radiogroup" aria-label="Motion">
        <button type="button" role="radio" aria-checked={!motion} className={!motion ? 'motion-card motion-card-active' : 'motion-card'} disabled={disabled} onClick={() => onChange(undefined)}>
          <span className="motion-card-stage">
            <span className="motion-card-dot" />
          </span>
          <small>None</small>
        </button>
        {CLIP_MOTION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={motion?.preset === preset}
            className={motion?.preset === preset ? 'motion-card motion-card-active' : 'motion-card'}
            disabled={disabled}
            title={CLIP_MOTION_HINTS[preset]}
            onClick={() => pick(preset)}
          >
            <span className="motion-card-stage">
              <span className={`motion-card-dot motion-demo-${preset}`} />
            </span>
            <small>{CLIP_MOTION_LABELS[preset]}</small>
          </button>
        ))}
      </div>
      {motion && (
        <div className="motion-picker-controls">
          <p className="motion-picker-hint">{CLIP_MOTION_HINTS[motion.preset]}</p>
          <label className="motion-picker-row">
            <span>Speed</span>
            <input type="range" min={0.25} max={3} step={0.05} value={motion.speed} disabled={disabled} onChange={(e) => onChange({ ...motion, speed: Number(e.target.value) })} />
            <span className="motion-picker-value">{motion.speed.toFixed(2)}×</span>
          </label>
          {motion.preset !== 'spin' && (
            <label className="motion-picker-row">
              <span>Amount</span>
              <input type="range" min={0.1} max={1} step={0.05} value={motion.amount} disabled={disabled} onChange={(e) => onChange({ ...motion, amount: Number(e.target.value) })} />
              <span className="motion-picker-value">{Math.round(motion.amount * 100)}%</span>
            </label>
          )}
          <p className="motion-picker-note">Plays in the Player and is exported with the video. Use Position and Scale to set where it moves around.</p>
        </div>
      )}
    </div>
  )
}
