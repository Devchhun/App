import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_PANEL_WIDTHS,
  LEFT_PANEL_MIN,
  PLAYER_MIN,
  RIGHT_PANEL_MIN,
  clampLeftWidth,
  clampRightWidth,
  defaultPanelWidthsForWindow,
  fitPanelWidthsToWindow,
  getPanelWidthsStorageKey,
  parseStoredPanelWidths,
  serializePanelWidths,
  type PanelWidthsState
} from './workspaceLayout'

/** Grid track for the icon rail: the 72px rail itself plus the same 8px
 * breathing room on each side that the Player keeps from its neighbours
 * (.panel-preview's side margins), so the rail floats like every other
 * panel instead of touching the window edge and the Media panel. */
const ICON_RAIL_WIDTH = 88

/** Templates/Properties panel widths as a UI preference: persisted to
 * localStorage (this machine's editor layout), deliberately NEVER written
 * into the project file or Undo history -- resizing a panel is not part of
 * the video being edited. Both panels stay open at all times; there is no
 * collapsed state. */
export function useWorkspaceLayout(): {
  widths: PanelWidthsState
  setLeftWidth: (px: number) => void
  setRightWidth: (px: number) => void
  resetLeftWidth: () => void
  resetRightWidth: () => void
} {
  const [widths, setWidths] = useState<PanelWidthsState>(() => {
    const windowDefault = typeof window === 'undefined' ? DEFAULT_PANEL_WIDTHS : defaultPanelWidthsForWindow(window.innerWidth)
    if (typeof localStorage === 'undefined') return windowDefault
    try {
      const raw = localStorage.getItem(getPanelWidthsStorageKey())
      // No stored preference yet (a genuinely fresh install/profile) gets the
      // window-size-aware default; a stored value (even a corrupt one) goes
      // through parseStoredPanelWidths as before, which falls back to the
      // plain, window-independent LEFT_PANEL_DEFAULT/RIGHT_PANEL_DEFAULT per
      // field -- there's no "current window" to scale against for a value
      // that was explicitly saved (and might be corrupt) rather than absent.
      return raw === null ? windowDefault : parseStoredPanelWidths(raw)
    } catch {
      return windowDefault
    }
  })

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(getPanelWidthsStorageKey(), serializePanelWidths(widths))
    } catch {
      // Storage unavailable/full -- the in-memory width still works for this session.
    }
  }, [widths])

  // Re-fit on window resize so a side panel never squeezes the Player below
  // its minimum (which would otherwise show a Preview scrollbar).
  useEffect(() => {
    const handleResize = (): void => {
      setWidths((prev) => fitPanelWidthsToWindow(prev, window.innerWidth, ICON_RAIL_WIDTH))
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const setLeftWidth = useCallback((px: number) => {
    setWidths((prev) => {
      const available = window.innerWidth - ICON_RAIL_WIDTH - PLAYER_MIN
      const maxWithoutOverflow = Math.max(LEFT_PANEL_MIN, available - prev.rightWidth)
      return { ...prev, leftWidth: Math.min(clampLeftWidth(px), maxWithoutOverflow) }
    })
  }, [])
  const setRightWidth = useCallback((px: number) => {
    setWidths((prev) => {
      // The right edge stays pinned to the window. Dragging its LEFT divider
      // left grows only into the Player area and can never push the panel
      // itself or the workspace beyond the right side of the viewport.
      const available = window.innerWidth - ICON_RAIL_WIDTH - PLAYER_MIN
      const maxWithoutOverflow = Math.max(RIGHT_PANEL_MIN, available - prev.leftWidth)
      return { ...prev, rightWidth: Math.min(clampRightWidth(px), maxWithoutOverflow) }
    })
  }, [])
  // Resets to what's proportional for the window's CURRENT size, not a
  // fixed pixel value -- so resetting on a large monitor actually gives a
  // large panel back, not the same fixed default a laptop would get too.
  const resetLeftWidth = useCallback(() => setWidths((prev) => ({ ...prev, leftWidth: defaultPanelWidthsForWindow(window.innerWidth).leftWidth })), [])
  const resetRightWidth = useCallback(() => setWidths((prev) => ({ ...prev, rightWidth: defaultPanelWidthsForWindow(window.innerWidth).rightWidth })), [])

  return { widths, setLeftWidth, setRightWidth, resetLeftWidth, resetRightWidth }
}

export { ICON_RAIL_WIDTH }
