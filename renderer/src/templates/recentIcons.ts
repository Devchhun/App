import type { TemplateIconId } from '@shared/templates'
import { TEMPLATE_ICON_IDS } from '@shared/templates'

// Recently-used icons are transient UI convenience state (not undo/redo
// history, not project data) -- persisted only in localStorage so the list
// survives across app relaunches without touching the project file or the
// history stack.
const STORAGE_KEY = 'creative-ai-editor.recentIcons'
const MAX_RECENT = 8

function getStorage(): Storage | null {
  // Guarded (rather than assuming `window` exists) so this module works
  // identically in the Electron renderer and in plain-node unit tests.
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function readStorage(): string[] {
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeStorage(ids: TemplateIconId[]): void {
  try {
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Storage unavailable/full -- recently-used is a convenience, safe to drop silently.
  }
}

export function loadRecentIcons(): TemplateIconId[] {
  const known = new Set<string>(TEMPLATE_ICON_IDS)
  return readStorage().filter((id): id is TemplateIconId => known.has(id))
}

export function pushRecentIcon(id: TemplateIconId): TemplateIconId[] {
  const next = [id, ...loadRecentIcons().filter((existing) => existing !== id)].slice(0, MAX_RECENT)
  writeStorage(next)
  return next
}
