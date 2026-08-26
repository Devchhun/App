import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_PANEL_WIDTHS,
  LEFT_PANEL_DEFAULT,
  RIGHT_PANEL_DEFAULT,
  clampLeftWidth,
  clampRightWidth,
  fitPanelWidthsToWindow,
  getPanelWidthsStorageKey,
  parseStoredPanelWidths,
  serializePanelWidths,
  type PanelWidthsState
} from './workspaceLayout'

const ICON_RAIL_WIDTH = 72

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
    if (typeof localStorage === 'undefined') return DEFAULT_PANEL_WIDTHS
    try {
      return parseStoredPanelWidths(localStorage.getItem(getPanelWidthsStorageKey()))
    } catch {
      return DEFAULT_PANEL_WIDTHS
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
    setWidths((prev) => ({ ...prev, leftWidth: clampLeftWidth(px) }))
  }, [])
  const setRightWidth = useCallback((px: number) => {
    setWidths((prev) => ({ ...prev, rightWidth: clampRightWidth(px) }))
  }, [])
  const resetLeftWidth = useCallback(() => setWidths((prev) => ({ ...prev, leftWidth: LEFT_PANEL_DEFAULT })), [])
  const resetRightWidth = useCallback(() => setWidths((prev) => ({ ...prev, rightWidth: RIGHT_PANEL_DEFAULT })), [])

  return { widths, setLeftWidth, setRightWidth, resetLeftWidth, resetRightWidth }
}

export { ICON_RAIL_WIDTH }
