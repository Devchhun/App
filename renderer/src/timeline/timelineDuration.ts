/** Visual Timeline extent. Sequence.duration already includes its own
 * trailing room; overlays and caption blocks need the same room when they
 * extend beyond the last ordinary clip. */
export function computeTimelineDisplayDuration(
  sequenceDuration: number,
  sceneEndTimes: number[],
  captionEndTimes: number[],
  tailSeconds = 5
): number {
  const furthestOverlayEnd = Math.max(0, ...sceneEndTimes, ...captionEndTimes)
  return Math.max(sequenceDuration, furthestOverlayEnd > 0 ? furthestOverlayEnd + tailSeconds : 0)
}
