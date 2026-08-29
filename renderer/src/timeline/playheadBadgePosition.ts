export type PlayheadBadgeEdge = 'left' | 'right' | null

/** Decides which side of the playhead line its own time-readout badge
 * should sit on, based on the playhead's position within the currently
 * VISIBLE scroll viewport (not the padded viewportRange used for clip/tick
 * culling -- see Timeline.tsx's own doc comment on the call site). Near the
 * left edge (most commonly time 0, always a ruler tick) the default
 * right-of-line offset lands the badge on top of that tick's own label;
 * near the right edge, the default offset can run the badge off-screen.
 * Both thresholds are in pixels, matching the badge's own approximate
 * width/a ruler tick's own label width. */
export function playheadBadgeEdge(
  playheadPx: number,
  visibleStartPx: number,
  visibleEndPx: number,
  leftThresholdPx = 40,
  rightThresholdPx = 60
): PlayheadBadgeEdge {
  if (playheadPx - visibleStartPx < leftThresholdPx) return 'left'
  if (visibleEndPx - playheadPx < rightThresholdPx) return 'right'
  return null
}
