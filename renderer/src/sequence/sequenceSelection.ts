// Pure Timeline-clip selection math -- click/ctrl-click/shift-click -- kept
// completely separate from (and with no awareness of) which Media asset is
// selected for inspection. That separation is the actual fix for "clicking a
// clip changes the active media" / "selecting media rebuilds the timeline":
// clip selection and media-asset selection are two different pieces of
// state, owned by two different contexts (SequenceContext / MediaContext),
// and neither's update function takes or returns anything about the other.

export interface ClickModifiers {
  ctrl?: boolean
  shift?: boolean
}

/** Given the current multi-selection, the clicked clip id, and the clips'
 * on-track order (for shift-range selection), returns the next selection:
 * - plain click: replace the selection with just this clip.
 * - ctrl+click: toggle this clip in/out of the selection.
 * - shift+click: select the contiguous range from the last-selected clip
 *   (the selection's current last entry) to this one, in track order.
 * A click with no modifiers on an already-sole-selected clip is a no-op
 * (returns the same array reference) so it doesn't spuriously re-record
 * history. */
export function updateClipSelection(current: string[], clickedId: string, orderedClipIds: string[], modifiers: ClickModifiers = {}): string[] {
  if (modifiers.shift && current.length > 0) {
    const anchorId = current[current.length - 1]
    const anchorIdx = orderedClipIds.indexOf(anchorId)
    const clickedIdx = orderedClipIds.indexOf(clickedId)
    if (anchorIdx === -1 || clickedIdx === -1) return [clickedId]
    const [from, to] = anchorIdx < clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx]
    return orderedClipIds.slice(from, to + 1)
  }

  if (modifiers.ctrl) {
    return current.includes(clickedId) ? current.filter((id) => id !== clickedId) : [...current, clickedId]
  }

  if (current.length === 1 && current[0] === clickedId) return current
  return [clickedId]
}

/** Clears the clip selection -- e.g. clicking empty Timeline area. A no-op
 * (same reference back) when already empty. */
export function clearClipSelection(current: string[]): string[] {
  return current.length === 0 ? current : []
}
