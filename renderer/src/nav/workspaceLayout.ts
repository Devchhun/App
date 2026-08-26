// Pure logic for the resizable Templates/Properties side panels -- widths,
// clamping, and localStorage (de)serialization. Kept framework-free so it's
// directly testable; the React hook (useWorkspaceLayout.ts) is the only
// place that actually touches `localStorage` or component state.

export const LEFT_PANEL_MIN = 340
export const LEFT_PANEL_MAX = 520
// Targets ~440-520px on a 1920-2560px display (was previously 400 -- the
// Preview column absorbing all the extra width on a large monitor was the
// original problem; Templates/Properties get that width instead, not the
// Preview getting more empty gutter around it).
export const LEFT_PANEL_DEFAULT = 460

export const RIGHT_PANEL_MIN = 320
export const RIGHT_PANEL_MAX = 460
// Targets ~380-440px on a 1920-2560px display.
export const RIGHT_PANEL_DEFAULT = 400

/** Below this, the center Player column would be squeezed under its own
 * usable minimum -- used to cap how wide the side panels are allowed to
 * grow given the CURRENT window width, on top of their own min/max. */
export const PLAYER_MIN = 600

export interface PanelWidthsState {
  leftWidth: number
  rightWidth: number
}

export const DEFAULT_PANEL_WIDTHS: PanelWidthsState = {
  leftWidth: LEFT_PANEL_DEFAULT,
  rightWidth: RIGHT_PANEL_DEFAULT
}

export function clampLeftWidth(px: number): number {
  if (!Number.isFinite(px)) return LEFT_PANEL_DEFAULT
  return Math.min(LEFT_PANEL_MAX, Math.max(LEFT_PANEL_MIN, px))
}

export function clampRightWidth(px: number): number {
  if (!Number.isFinite(px)) return RIGHT_PANEL_DEFAULT
  return Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, px))
}

/** The draggable splitter's pointer hit-area width (in px) -- purely visual
 * overlay math (see computeSplitterOffsets); it is NOT a grid track and
 * consumes no layout width, so the panels can sit flush against each other
 * with only a 1px divider line. */
export const SPLITTER_HIT_WIDTH = 5

/** If the window is too narrow for both side panels at their current widths
 * plus the Player's own minimum, shrinks the side panels (never below their
 * own MIN) so the Player always keeps at least PLAYER_MIN -- this is what
 * keeps resizing a side panel from ever producing a Preview scrollbar. On
 * screens too narrow even at both panels' minimums, panels should collapse
 * (a manual choice the user makes by dragging a splitter closed, not this
 * function's job to force). */
export function fitPanelWidthsToWindow(widths: PanelWidthsState, windowWidth: number, iconRailWidth: number): PanelWidthsState {
  const left = widths.leftWidth
  const right = widths.rightWidth
  const available = windowWidth - iconRailWidth - PLAYER_MIN
  if (left + right <= available || available <= 0) return widths

  const shrinkable = left + right - available
  const leftRoom = left - LEFT_PANEL_MIN
  const rightRoom = right - RIGHT_PANEL_MIN
  const totalRoom = leftRoom + rightRoom
  if (totalRoom <= 0) return widths

  const leftShrink = (shrinkable * leftRoom) / totalRoom
  const rightShrink = (shrinkable * rightRoom) / totalRoom

  return {
    leftWidth: clampLeftWidth(left - leftShrink),
    rightWidth: clampRightWidth(right - rightShrink)
  }
}

const STORAGE_KEY = 'cae-workspace-panel-widths-v2'

export function getPanelWidthsStorageKey(): string {
  return STORAGE_KEY
}

/** Parses a raw localStorage value into a valid, clamped PanelWidthsState.
 * Any parse error, missing field, or out-of-range value falls back to the
 * default for that field individually -- a corrupt/old value never breaks
 * the whole layout, just resets the affected panel to its default. */
export function parseStoredPanelWidths(raw: string | null): PanelWidthsState {
  if (!raw) return DEFAULT_PANEL_WIDTHS
  try {
    const parsed = JSON.parse(raw) as Partial<PanelWidthsState>
    return {
      leftWidth: typeof parsed.leftWidth === 'number' ? clampLeftWidth(parsed.leftWidth) : DEFAULT_PANEL_WIDTHS.leftWidth,
      rightWidth: typeof parsed.rightWidth === 'number' ? clampRightWidth(parsed.rightWidth) : DEFAULT_PANEL_WIDTHS.rightWidth
    }
  } catch {
    return DEFAULT_PANEL_WIDTHS
  }
}

export function serializePanelWidths(widths: PanelWidthsState): string {
  return JSON.stringify(widths)
}

/** Builds the `.workspace` grid's `grid-template-columns` value from the
 * current panel widths -- the single source of truth both the live layout
 * and any test asserting column sizing should use. Four tracks: icon rail,
 * left panel, Player, right panel -- matching the four DOM children
 * Workspace (App.tsx) renders in that order, with `gap: 0` so Templates,
 * Preview, and Properties sit flush against each other. Side panels stay
 * open at all times (no collapsed state) -- the Player column absorbs
 * whatever width the panels don't use, via `minmax(PLAYER_MIN, 1fr)`. The
 * draggable splitters are separate absolutely-positioned overlays (see
 * computeSplitterOffsets), not grid tracks -- they consume no layout width. */
export function buildWorkspaceGridColumns(widths: PanelWidthsState, iconRailWidth = 72): string {
  const left = `${clampLeftWidth(widths.leftWidth)}px`
  const right = `${clampRightWidth(widths.rightWidth)}px`
  return `${iconRailWidth}px ${left} minmax(${PLAYER_MIN}px, 1fr) ${right}`
}

/** Pixel offsets for the two splitter overlays, measured from `.workspace`'s
 * own left/right padding edges (its containing block for `position:
 * absolute`, given `.workspace { position: relative }`) -- the same
 * containing block CSS grid tracks lay out within, so these line up with
 * the grid's actual column boundaries with no separate correction needed.
 * The left splitter sits at the Templates/Player boundary (from the left);
 * the right splitter sits at the Player/Properties boundary (from the
 * right, so it doesn't need to know the Player's own computed pixel width). */
export function computeSplitterOffsets(widths: PanelWidthsState, iconRailWidth: number): { leftSplitterLeft: number; rightSplitterRight: number } {
  return {
    leftSplitterLeft: iconRailWidth + clampLeftWidth(widths.leftWidth),
    rightSplitterRight: clampRightWidth(widths.rightWidth)
  }
}
