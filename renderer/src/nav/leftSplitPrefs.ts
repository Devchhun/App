// Height of the Transcript / AI Suggestions preview strip under the Media
// grid -- a per-machine layout preference (same versioned-key pattern as
// timelineViewPrefs.ts), never part of the project file.

const STORAGE_KEY = 'cae-left-split-height-v1'

export const LEFT_SPLIT_MIN = 72
export const LEFT_SPLIT_MAX = 640
export const LEFT_SPLIT_DEFAULT = 220

export function clampLeftSplitHeight(px: number): number {
  if (!Number.isFinite(px)) return LEFT_SPLIT_DEFAULT
  return Math.min(LEFT_SPLIT_MAX, Math.max(LEFT_SPLIT_MIN, Math.round(px)))
}

export function readStoredLeftSplitHeight(): number {
  if (typeof localStorage === 'undefined') return LEFT_SPLIT_DEFAULT
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? LEFT_SPLIT_DEFAULT : clampLeftSplitHeight(Number(raw))
  } catch {
    return LEFT_SPLIT_DEFAULT
  }
}

export function persistLeftSplitHeight(px: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, String(px))
  } catch {
    // Storage unavailable/full -- the in-memory height still applies this session.
  }
}
