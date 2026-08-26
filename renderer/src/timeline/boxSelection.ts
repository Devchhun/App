// Marquee/box selection (spec section 8) -- pure rectangle-intersection math
// and the resulting selection-set logic. Screen-space coordinates only (the
// caller is responsible for translating pointer events into this space,
// same as everywhere else drag math already lives in this codebase).
import type { ClickModifiers } from '../sequence/sequenceSelection'

export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ClipGeometry {
  id: string
  trackId: string
  left: number
  right: number
  top: number
  bottom: number
}

/** Builds a normalized rect (left<=right, top<=bottom) from two arbitrary
 * drag corners -- a box-select drag can go in any of the four directions. */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): ScreenRect {
  return { left: Math.min(x0, x1), right: Math.max(x0, x1), top: Math.min(y0, y1), bottom: Math.max(y0, y1) }
}

function intersects(rect: ScreenRect, geo: ClipGeometry): boolean {
  return rect.left < geo.right && rect.right > geo.left && rect.top < geo.bottom && rect.bottom > geo.top
}

/** Every clip (by id) whose geometry intersects `rect`, across however many
 * tracks it spans -- box selection is explicitly multi-track (spec). */
export function clipsInRect(rect: ScreenRect, geometries: ClipGeometry[]): string[] {
  return geometries.filter((g) => intersects(rect, g)).map((g) => g.id)
}

/** Default drag: replaces the selection with exactly what's in the box.
 * Ctrl+drag: toggles each intersected clip in/out of the current selection.
 * Shift+drag: adds every intersected clip to the current selection (union). */
export function applyBoxSelection(current: string[], hitIds: string[], modifiers: ClickModifiers = {}): string[] {
  if (modifiers.ctrl) {
    const set = new Set(current)
    for (const id of hitIds) {
      if (set.has(id)) set.delete(id)
      else set.add(id)
    }
    return [...set]
  }
  if (modifiers.shift) {
    const set = new Set(current)
    for (const id of hitIds) set.add(id)
    return [...set]
  }
  return [...hitIds]
}
