// Small interpolation helper for the motion templates' enter/hold/exit
// timing. Deliberately framework-free (no Remotion dependency) -- see
// GraphicsOverlay.tsx for why the editable preview renders these as plain
// DOM elements driven by the video's currentTime instead.
import type { AnimationPreset, AnimationEasing } from '@shared/templates'

export function clampInterpolate(t: number, inputRange: [number, number], outputRange: [number, number]): number {
  const [inMin, inMax] = inputRange
  const [outMin, outMax] = outputRange
  if (inMax === inMin) return outMax
  if (t <= inMin) return outMin
  if (t >= inMax) return outMax
  const ratio = (t - inMin) / (inMax - inMin)
  return outMin + ratio * (outMax - outMin)
}

const EASING_FN: Record<AnimationEasing, (t: number) => number> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
}

/** Shared easing lookup so internal-motion helpers (e.g. getStaggeredItemProgress
 * in motion.ts) can respect the same scene-level easing curve as the
 * whole-container fade, without duplicating the curve definitions. */
export function getEasingFn(easing: AnimationEasing = 'ease-out'): (t: number) => number {
  return EASING_FN[easing] ?? EASING_FN['ease-out']
}

export interface SceneMotion {
  visible: boolean
  opacity: number
  /** 0 at scene start, ramps to 1 over the enter window (eased) and stays there through the hold. */
  enterProgress: number
  /** 0 through the hold, ramps 0->1 (eased) over the exit window at the end of the scene. */
  exitProgress: number
}

export type AnimationIntensity = 'minimal' | 'balanced' | 'energetic' | 'cinematic' | 'custom'

const ENTER_EXIT_SECONDS_BY_INTENSITY: Record<AnimationIntensity, number> = {
  minimal: 0.2,
  balanced: 0.4,
  energetic: 0.55,
  cinematic: 0.7,
  custom: 0.4
}

export interface SceneMotionOptions {
  intensity?: AnimationIntensity
  /** Per-scene override (Properties > Timing > In/Out duration); falls back to the brand's animationIntensity when unset. */
  enterSeconds?: number
  exitSeconds?: number
  easing?: AnimationEasing
}

export function computeSceneMotion(currentTime: number, startTime: number, endTime: number, options: SceneMotionOptions = {}): SceneMotion {
  if (currentTime < startTime || currentTime >= endTime) {
    return { visible: false, opacity: 0, enterProgress: 0, exitProgress: 0 }
  }
  const { intensity = 'balanced', easing = 'ease-out' } = options
  const fallbackSeconds = ENTER_EXIT_SECONDS_BY_INTENSITY[intensity]
  const duration = Math.max(0.01, endTime - startTime)
  const enterDuration = Math.min(options.enterSeconds ?? fallbackSeconds, duration / 2)
  const exitDuration = Math.min(options.exitSeconds ?? fallbackSeconds, duration / 2)
  const t = currentTime - startTime
  const ease = EASING_FN[easing]

  const enterProgress = ease(clampInterpolate(t, [0, enterDuration], [0, 1]))
  const exitProgress = ease(clampInterpolate(t, [duration - exitDuration, duration], [0, 1]))
  const opacity = Math.min(enterProgress, 1 - exitProgress)

  return { visible: true, opacity, enterProgress, exitProgress }
}

const MOTION_PRESET_TRANSFORMS: Record<AnimationPreset, (enter: number, exit: number) => string> = {
  // 'none' (not '') so this inline value is never an empty string -- an
  // empty inline `transform` is ignored by the browser and falls through to
  // whatever the template's own CSS class declares (several templates' base
  // class centers itself with `transform: translate(-50%, -50%)`), which
  // would silently re-apply that centering even when Position & Size has
  // moved the box somewhere else entirely.
  fade: () => 'none',
  'scale-in': (enter, exit) => `scale(${0.85 + 0.15 * enter - 0.05 * exit})`,
  'slide-up': (enter, exit) => `translateY(${20 * (1 - enter) - 20 * exit}px)`,
  'slide-down': (enter, exit) => `translateY(${-20 * (1 - enter) + 20 * exit}px)`,
  pop: (enter, exit) => {
    const overshoot = Math.sin(Math.min(enter, 1) * Math.PI) * 0.12
    const scale = (0.6 + 0.4 * enter + overshoot) * (1 - 0.3 * exit)
    return `scale(${scale})`
  }
}

/** Applies an explicit per-scene animation preset (Properties > Animation).
 * When a scene has no preset chosen, templates fall back to their own
 * historical per-template default motion instead of calling this. */
export function getMotionTransform(preset: AnimationPreset, motion: SceneMotion): string {
  return MOTION_PRESET_TRANSFORMS[preset](motion.enterProgress, motion.exitProgress)
}

/** Remaps `t` from the window [start, end] to [0, 1], clamped. Used by the
 * multi-element cinematic templates (Tech Title Scene, Three-Step Presenter
 * Plan, Device Compatibility Lineup) to derive each element's own reveal
 * progress purely from the scene's overall `enterProgress` -- never wall
 * clock time -- so seeking the timeline is perfectly repeatable. */
export function remap(t: number, start: number, end: number): number {
  if (end === start) return t >= end ? 1 : 0
  return Math.max(0, Math.min(1, (t - start) / (end - start)))
}

/** Splits an overall 0-1 progress across `count` sequential items: item
 * `index` starts once `progress * count` exceeds `index`, and reaches 1 once
 * it exceeds `index + 1`. Deterministic and framework-free, same formula
 * Checklist.tsx already used inline for per-row stagger. */
export function stagger(progress: number, index: number, count: number): number {
  if (count <= 0) return progress
  return Math.max(0, Math.min(1, progress * count - index))
}
