// Pure Media-panel multi-select math -- click/ctrl-click/shift-click/select-
// all -- mirrors renderer/src/sequence/sequenceSelection.ts's clip-selection
// pattern exactly (same algorithm, same ClickModifiers shape, reused rather
// than redeclared). Deliberately independent of MediaContext's existing
// single `selectedId` (the "asset currently open for inspection"/Preview
// source) -- multi-select is for choosing several assets to drag onto the
// Timeline together, a separate concern.
import type { ClickModifiers } from '../sequence/sequenceSelection'

export type { ClickModifiers }

export function updateMediaSelection(current: string[], clickedId: string, orderedIds: string[], modifiers: ClickModifiers = {}): string[] {
  if (modifiers.shift && current.length > 0) {
    const anchorId = current[current.length - 1]
    const anchorIdx = orderedIds.indexOf(anchorId)
    const clickedIdx = orderedIds.indexOf(clickedId)
    if (anchorIdx === -1 || clickedIdx === -1) return [clickedId]
    const [from, to] = anchorIdx < clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx]
    return orderedIds.slice(from, to + 1)
  }

  if (modifiers.ctrl) {
    return current.includes(clickedId) ? current.filter((id) => id !== clickedId) : [...current, clickedId]
  }

  if (current.length === 1 && current[0] === clickedId) return current
  return [clickedId]
}

export function clearMediaSelection(current: string[]): string[] {
  return current.length === 0 ? current : []
}

export function selectAllMedia(orderedIds: string[]): string[] {
  return orderedIds
}
