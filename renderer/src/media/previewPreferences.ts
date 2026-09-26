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

/** Player menu > Preview: 'performance' plays the proxy (smooth),
 * 'quality' the original file at full resolution. */
export type PreviewQuality = 'performance' | 'quality'

const QUALITY_STORAGE_KEY = 'cae-preview-quality-v1'

export function getPreviewQualityStorageKey(): string {
  return QUALITY_STORAGE_KEY
}

export function parseStoredPreviewQuality(raw: string | null): PreviewQuality {
  return raw === 'quality' ? 'quality' : 'performance'
}

/** Player menu > Color oscilloscope: shown or hidden. */
const SCOPE_STORAGE_KEY = 'cae-preview-scope-v1'

export function getScopeStorageKey(): string {
  return SCOPE_STORAGE_KEY
}

export function parseStoredScopeVisible(raw: string | null): boolean {
  return raw === '1'
}
