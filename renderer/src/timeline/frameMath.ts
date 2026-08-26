// Frame-accurate time math (spec sections 6, 11) -- used by playhead
// scrubbing/frame-step shortcuts and the Blade tool's exact-frame split.
export const DEFAULT_FPS = 30

/** Snaps `time` to the nearest exact frame boundary at `fps`. */
export function frameTime(time: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(fps) || fps <= 0) return time
  return Math.round(time * fps) / fps
}

/** The duration of one frame, in seconds, at `fps` -- the step size for
 * frame-by-frame navigation (Left/Right arrow keys). */
export function frameDuration(fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(fps) || fps <= 0) return 1 / DEFAULT_FPS
  return 1 / fps
}
