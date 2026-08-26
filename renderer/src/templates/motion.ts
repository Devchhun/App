// Deterministic internal-element motion system: every template's individual
// pieces (platforms, rows, pills, connectors, packets...) choreograph off a
// single pure function of scene time, never Date.now()/setInterval/rAF
// inside a template. Seeking to the same timestamp always reproduces the
// exact same frame; smooth playback comes from the *driver* (PreviewPlayer's
// requestVideoFrameCallback/rAF loop feeding currentTime), never from a
// template-owned clock.
import { remap, getEasingFn } from './animation'
import type { MotionPreset, AnimationEasing } from '@shared/templates'

export type { MotionPreset }

export interface TemplateMotionFrame {
  /** Seconds since scene.startTime. Not clamped -- callers only ever see
   * values inside [0, duration) in practice, since GraphicsOverlay doesn't
   * render a scene outside its time range at all. */
  localTime: number
  duration: number
  /** 0-1, eased-free linear ramp over the enter window (each caller applies
   * its own easing/curves on top, since different elements want different shapes). */
  enterProgress: number
  /** Seconds elapsed since the hold phase began -- unclamped and keeps
   * growing through the exit phase too, so loop math (`loopProgress`, `pulse`,
   * `deterministicRotation`) never has a discontinuity at the hold/exit boundary. */
  holdTime: number
  /** 0-1 across the hold window specifically (0 at hold start, 1 at hold end). */
  holdProgress: number
  /** 0-1 ramp over the exit window. */
  exitProgress: number
  /** 0-1, normalized from the resolved motionIntensity (0-100). */
  intensity: number
  loopEnabled: boolean
  loopSpeed: number
}

export interface ResolvedMotionOptions {
  preset: MotionPreset
  /** 0-100. */
  intensity: number
  loopEnabled: boolean
  loopSpeed: number
  staggerDelay: number
  enterDuration: number
  exitDuration: number
}

/** Suggested per-preset defaults (spec: None/Gentle/Dynamic/Technical/Cinematic). */
const PRESET_DEFAULTS: Record<MotionPreset, Omit<ResolvedMotionOptions, 'preset'>> = {
  none: { intensity: 0, loopEnabled: false, loopSpeed: 1, staggerDelay: 0, enterDuration: 0.01, exitDuration: 0.01 },
  gentle: { intensity: 40, loopEnabled: true, loopSpeed: 0.6, staggerDelay: 0.1, enterDuration: 0.5, exitDuration: 0.4 },
  dynamic: { intensity: 85, loopEnabled: true, loopSpeed: 1.3, staggerDelay: 0.06, enterDuration: 0.35, exitDuration: 0.3 },
  technical: { intensity: 70, loopEnabled: true, loopSpeed: 1, staggerDelay: 0.09, enterDuration: 0.55, exitDuration: 0.4 },
  cinematic: { intensity: 55, loopEnabled: true, loopSpeed: 0.5, staggerDelay: 0.12, enterDuration: 0.75, exitDuration: 0.55 }
}

export function getMotionPresetDefaults(preset: MotionPreset): ResolvedMotionOptions {
  return { preset, ...PRESET_DEFAULTS[preset] }
}

interface MotionSceneFields {
  motionPreset?: MotionPreset
  motionIntensity?: number
  loopEnabled?: boolean
  loopSpeed?: number
  staggerDelay?: number
  enterDuration?: number
  exitDuration?: number
}

/** Merges a scene's explicit overrides onto its (or the template's default)
 * preset. Every field is independently overridable -- e.g. a scene can use
 * the 'technical' preset's timings but disable looping. */
export function resolveMotionOptions(scene: MotionSceneFields, defaultPreset: MotionPreset = 'technical'): ResolvedMotionOptions {
  const preset = scene.motionPreset ?? defaultPreset
  const base = PRESET_DEFAULTS[preset]
  return {
    preset,
    intensity: scene.motionIntensity ?? base.intensity,
    loopEnabled: scene.loopEnabled ?? base.loopEnabled,
    loopSpeed: scene.loopSpeed ?? base.loopSpeed,
    staggerDelay: scene.staggerDelay ?? base.staggerDelay,
    enterDuration: scene.enterDuration ?? base.enterDuration,
    exitDuration: scene.exitDuration ?? base.exitDuration
  }
}

/** The single source of truth for a template's internal choreography: pure
 * function of (currentTime, startTime, endTime, resolved options). Every
 * per-element progress value in a template should derive from this frame
 * (via `remap`/`stagger` for enter-phase staggering, and the loop/pulse/float
 * helpers below for hold-phase movement) -- never from wall-clock time. */
export function computeTemplateMotionFrame(currentTime: number, startTime: number, endTime: number, options: ResolvedMotionOptions): TemplateMotionFrame {
  const duration = Math.max(0.01, endTime - startTime)
  const localTime = currentTime - startTime

  const enterDuration = Math.max(0, Math.min(options.enterDuration, duration))
  const exitDuration = Math.max(0, Math.min(options.exitDuration, duration))
  const holdStart = enterDuration
  const holdEnd = Math.max(holdStart, duration - exitDuration)

  const enterProgress = remap(localTime, 0, enterDuration)
  const holdProgress = remap(localTime, holdStart, holdEnd)
  const exitProgress = remap(localTime, holdEnd, duration)
  const holdTime = Math.max(0, localTime - holdStart)

  return {
    localTime,
    duration,
    enterProgress,
    holdTime,
    holdProgress,
    exitProgress,
    intensity: Math.max(0, Math.min(100, options.intensity)) / 100,
    loopEnabled: options.loopEnabled,
    loopSpeed: options.loopSpeed
  }
}

export function easeOut(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return 1 - (1 - c) * (1 - c)
}

export function easeInOut(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2
}

/** A repeating 0-1 ramp derived from `holdTime` (seconds since hold began,
 * unclamped/ever-growing) -- e.g. a packet travelling along a connector.
 * `period` is the loop length in seconds at speed 1; `offset` (0-1) staggers
 * multiple loops that share a period out of phase with each other. */
export function loopProgress(holdTime: number, speed: number, period: number, offset = 0): number {
  if (period <= 0) return 0
  const raw = (holdTime * speed) / period + offset
  const wrapped = raw % 1
  return wrapped < 0 ? wrapped + 1 : wrapped
}

/** A smooth 0-1-0 breathing/pulsing value, e.g. a warning node's glow. */
export function pulse(holdTime: number, speed: number, min = 0.7, max = 1): number {
  const wave = 0.5 + 0.5 * Math.sin(holdTime * speed * Math.PI * 2)
  return min + (max - min) * wave
}

/** Progress of an SVG line draw (via stroke-dashoffset) across an arbitrary
 * window of `localTime` -- a named alias of `remap` so template code reads
 * clearly ("draw this connector between 1.00s and 1.55s"). */
export const lineDrawProgress = remap

/** A deterministic small floating offset (e.g. a subtle vertical drift on a
 * glow or icon), in the same units as `amplitude`. */
export function deterministicFloat(holdTime: number, speed: number, amplitude: number, phase = 0): number {
  return Math.sin(holdTime * speed + phase) * amplitude
}

/** A deterministic continuous rotation in degrees (e.g. a slowly turning wheel). */
export function deterministicRotation(holdTime: number, degreesPerSecond: number, offset = 0): number {
  const raw = (holdTime * degreesPerSecond + offset) % 360
  return raw < 0 ? raw + 360 : raw
}

export interface StaggeredItemProgressInput {
  /** Seconds since scene.startTime (`frame.localTime`) -- never wall-clock time. */
  localTime: number
  /** Seconds since scene.startTime at which this stagger sequence begins (e.g. a
   * phase offset already scaled into seconds by the caller). */
  phaseStart: number
  itemIndex: number
  itemCount: number
  /** Seconds between one item's entrance starting and the next item's starting. */
  staggerDelay: number
  /** The scene's resolved enter-phase length, used to size a sane default
   * per-item duration when `itemDuration` isn't given. */
  enterDuration: number
  /** Seconds an individual item's own entrance takes, start to finish.
   * Defaults to a fraction of `enterDuration` so a short/instant enter window
   * (e.g. the 'none' preset) keeps items effectively simultaneous. */
  itemDuration?: number
  /** 0-1, typically `frame.intensity` -- higher intensity makes each item's
   * own reveal slightly snappier. */
  intensity?: number
  /** Defaults to 'ease-out', matching the whole-scene fade's default curve. */
  easing?: AnimationEasing
}

const MAX_STAGGER_DELAY_SECONDS = 5
const DEFAULT_ITEM_DURATION_FRACTION = 0.55

/** The single source of timing truth for "N repeated elements enter one
 * after another": item `itemIndex` starts `itemIndex * staggerDelay` seconds
 * after `phaseStart` and reaches 1 after its own `itemDuration`. Pure
 * function of `localTime` -- seeking to the same timestamp always reproduces
 * the same progress, and there is no dependency on item count for the
 * per-item timing itself (unlike the older `stagger()` helper, which divided
 * a fixed window evenly by count). Invalid/negative/absurdly large inputs are
 * normalized to safe defaults instead of producing NaN or runaway timing. */
export function getStaggeredItemProgress(input: StaggeredItemProgressInput): number {
  const itemCount = Number.isFinite(input.itemCount) && input.itemCount > 0 ? Math.max(1, Math.floor(input.itemCount)) : 1
  const rawIndex = Number.isFinite(input.itemIndex) ? Math.floor(input.itemIndex) : 0
  const itemIndex = Math.max(0, Math.min(itemCount - 1, rawIndex))
  const enterDuration = Number.isFinite(input.enterDuration) && input.enterDuration > 0 ? input.enterDuration : 0.4
  const phaseStart = Number.isFinite(input.phaseStart) && input.phaseStart >= 0 ? input.phaseStart : 0
  const staggerDelay =
    Number.isFinite(input.staggerDelay) && input.staggerDelay > 0 ? Math.min(input.staggerDelay, MAX_STAGGER_DELAY_SECONDS) : 0
  const intensity = Number.isFinite(input.intensity) ? Math.max(0, Math.min(1, input.intensity as number)) : 0.5
  const baseItemDuration =
    Number.isFinite(input.itemDuration) && (input.itemDuration as number) > 0
      ? (input.itemDuration as number)
      : Math.max(0.02, enterDuration * DEFAULT_ITEM_DURATION_FRACTION)
  // Higher motion intensity -> a slightly snappier per-item reveal.
  const itemDuration = Math.max(0.02, baseItemDuration * (1.15 - 0.3 * intensity))

  const itemStart = phaseStart + itemIndex * staggerDelay
  const localTime = Number.isFinite(input.localTime) ? input.localTime : 0
  const raw = (localTime - itemStart) / itemDuration
  const clamped = Math.max(0, Math.min(1, raw))
  return getEasingFn(input.easing ?? 'ease-out')(clamped)
}
