/** A clip's Position (ClipTransform.x / .y, and their keyframes) is
 * measured on a reference canvas whose short side is 1080 px -- a 16:9
 * project is 1920 x 1080, a 9:16 one 1080 x 1920 -- and scaled to whatever
 * size the picture is shown or exported at.
 *
 * It used to mean "pixels" in two different ways: the Player moved the
 * picture by that many pixels of the small preview (about 660 wide) and
 * Export by that many pixels of the exported frame (1920, 3840...), so a
 * picture moved in Properties sat somewhere else in the exported video --
 * and somewhere else again at another export resolution. */
export const POSITION_REFERENCE_SHORT_SIDE = 1080

/** Pixels of a frame of this size per Position unit. */
export function positionScale(frame: { width: number; height: number }): number {
  const short = Math.min(frame.width, frame.height)
  return short > 0 ? short / POSITION_REFERENCE_SHORT_SIDE : 1
}
