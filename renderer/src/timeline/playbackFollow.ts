/** Smoothly follows playback once the playhead reaches the forward guide.
 * Returning the existing scroll position inside the guide avoids needless
 * writes; easing toward the target avoids the old full-page jump. */
export function nextPlaybackScrollLeft(
  playheadX: number,
  scrollLeft: number,
  viewportWidth: number,
  forwardGuideRatio = 0.72,
  easing = 0.35
): number {
  if (viewportWidth <= 0) return scrollLeft
  const screenX = playheadX - scrollLeft
  if (screenX >= 0 && screenX <= viewportWidth * forwardGuideRatio) return scrollLeft
  const guide = screenX < 0 ? viewportWidth * 0.1 : viewportWidth * forwardGuideRatio
  const target = Math.max(0, playheadX - guide)
  const delta = target - scrollLeft
  if (Math.abs(delta) < 0.5) return target
  return Math.max(0, scrollLeft + delta * easing)
}
