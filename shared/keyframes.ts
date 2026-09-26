// Keyframe animation for Timeline clips -- pure, dependency-free, used by
// both the renderer (live Preview) and, in a later phase, the main-process
// export compositor. A property with no keyframes (undefined or an empty
// array) is untouched by any of this: every existing static clip property
// (transform.x, opacity, volume, ...) keeps meaning exactly what it already
// does. Keyframes are a purely additive, opt-in-per-property overlay.

export type KeyframeEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export interface ClipKeyframe {
  id: string
  /** Seconds, relative to the CLIP's own start (0 = the clip's first frame),
   * not the sequence/project timeline. Matches how fadeIn/fadeOut are
   * already expressed on TimelineClip. */
  time: number
  value: number
  /** Eases the segment leading INTO this keyframe from the previous one.
   * Undefined/omitted on the first keyframe of a property has no effect
   * (there's nothing before it to ease from). Defaults to 'linear'. */
  easing?: KeyframeEasing
}

export type KeyframeableProperty = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'cropTop' | 'cropRight' | 'cropBottom' | 'cropLeft' | 'opacity' | 'volume'

export type ClipKeyframes = Partial<Record<KeyframeableProperty, ClipKeyframe[]>>

function applyEasing(t: number, easing: KeyframeEasing | undefined): number {
  const clamped = Math.min(1, Math.max(0, t))
  switch (easing) {
    case 'ease-in':
      return clamped * clamped
    case 'ease-out':
      return 1 - (1 - clamped) * (1 - clamped)
    case 'ease-in-out':
      return clamped < 0.5 ? 2 * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 2) / 2
    case 'linear':
    default:
      return clamped
  }
}

/** The single source of truth for "what is this property's value at time
 * `time`" -- 0 keyframes returns `fallback` unchanged (today's exact static
 * behavior); 1 keyframe is a constant at that value for the whole clip;
 * 2+ interpolates between the bracketing pair (eased per the LATER
 * keyframe's own `easing`, since that's the segment being eased into), and
 * clamps flat to the first/last keyframe's value before/after the whole
 * range -- never extrapolates. `keyframes` does not need to be pre-sorted;
 * this sorts a local copy by `time`. */
export function interpolateKeyframes(keyframes: ClipKeyframe[] | undefined, time: number, fallback: number): number {
  if (!keyframes || keyframes.length === 0) return fallback
  if (keyframes.length === 1) return keyframes[0].value

  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  if (time <= sorted[0].time) return sorted[0].value
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time
      const rawT = span <= 0 ? 1 : (time - a.time) / span
      const easedT = applyEasing(rawT, b.easing)
      return a.value + (b.value - a.value) * easedT
    }
  }
  // Unreachable given the range checks above, but keeps the function total.
  return sorted[sorted.length - 1].value
}

/** Whether a property actually has enough keyframes to vary over time (0 or
 * 1 keyframes behave as a constant, matching interpolateKeyframes) -- lets
 * callers decide whether they need to re-evaluate a clip's visual/audio
 * style every frame (keyframed) or can memoize on clip identity alone
 * (not keyframed, today's exact behavior). */
export function isAnimated(keyframes: ClipKeyframe[] | undefined): boolean {
  return !!keyframes && keyframes.length >= 2
}
