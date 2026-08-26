// Local UI preferences for the Preview player -- persisted to localStorage
// only (never the project file/Undo history), same rationale as the
// workspace panel widths (renderer/src/nav/workspaceLayout.ts).

export type PreviewFitMode = 'contain' | 'cover'

const FIT_MODE_STORAGE_KEY = 'cae-preview-fit-mode-v1'

export function getFitModeStorageKey(): string {
  return FIT_MODE_STORAGE_KEY
}

/** Parses a raw localStorage value into a valid PreviewFitMode, falling back
 * to 'contain' (Fit) for anything missing/corrupt/unrecognized. */
export function parseStoredFitMode(raw: string | null): PreviewFitMode {
  return raw === 'contain' || raw === 'cover' ? raw : 'contain'
}
