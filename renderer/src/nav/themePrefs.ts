// App light/dark theme -- a per-machine preference (same versioned-key,
// parse-with-fallback pattern as timelineViewPrefs.ts and voxcpmSettings.ts),
// deliberately NOT part of the project file: which theme someone edits in is
// a fact about their screen and their eyes, not about the video.

export type AppTheme = 'dark' | 'light'

export const DEFAULT_APP_THEME: AppTheme = 'dark'

const THEMES: AppTheme[] = ['dark', 'light']

const STORAGE_KEY = 'cae-theme-v1'

export function getThemeStorageKey(): string {
  return STORAGE_KEY
}

export function parseStoredTheme(raw: string | null): AppTheme {
  return THEMES.includes(raw as AppTheme) ? (raw as AppTheme) : DEFAULT_APP_THEME
}

/** Dark is the app's own default rather than the OS's: this is a video
 * editor, where a dark surround is what keeps the picture being graded
 * looking like itself. `light` is opt-in. */
export function readStoredTheme(): AppTheme {
  if (typeof localStorage === 'undefined') return DEFAULT_APP_THEME
  try {
    return parseStoredTheme(localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_APP_THEME
  }
}

/** Written straight onto <html> so every rule in styles.css sees it, rather
 * than threaded through React -- the palette lives entirely in CSS variables
 * (see :root[data-theme='light']), so one attribute is the whole switch. */
export function applyTheme(theme: AppTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

export function persistTheme(theme: AppTheme): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage unavailable/full -- the in-memory theme still applies this session.
  }
}
