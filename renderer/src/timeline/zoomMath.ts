// Cursor-centered zoom math (spec section 14) -- keeps the timeline time
// under the mouse cursor visually fixed while pixelsPerSecond changes, and
// never touches the playhead. Pure math only; the wheel-event wiring lives
// in Timeline.tsx.
import { clampPixelsPerSecond } from './timelineViewPrefs'

/** New horizontal scroll offset that keeps the same project time under the
 * cursor at the same screen x after zooming from `oldPps` to `newPps`.
 * `cursorX` is the cursor's x position relative to the scrollable content's
 * own left edge (i.e. already `clientX - contentRect.left + scrollLeft`, or
 * equivalently computed the same way `dropTimeFromClientX` already does
 * elsewhere in Timeline.tsx). */
export function computeZoomAroundCursor(scrollLeft: number, cursorX: number, oldPps: number, newPps: number): number {
  if (oldPps <= 0) return Math.max(0, scrollLeft)
  const timeAtCursor = (scrollLeft + cursorX) / oldPps
  return Math.max(0, timeAtCursor * newPps - cursorX)
}

/** pixelsPerSecond + scrollLeft that fit exactly [startTime, endTime] into a
 * viewport `viewportWidthPx` wide -- used by both "zoom to selection" and
 * "zoom to in/out range" (spec section 14), which differ only in which time
 * range they pass in. */
export function zoomToRange(startTime: number, endTime: number, viewportWidthPx: number): { pixelsPerSecond: number; scrollLeft: number } {
  const duration = Math.max(0.01, endTime - startTime)
  const pixelsPerSecond = clampPixelsPerSecond(viewportWidthPx / duration)
  return { pixelsPerSecond, scrollLeft: Math.max(0, startTime * pixelsPerSecond) }
}
