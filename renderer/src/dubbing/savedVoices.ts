import { kiriVoiceOf } from '@shared/kiriTts'

/** Custom voices the user recorded and named, so one character's voice can
 * be reused across subtitles, across sessions, and across PROJECTS.
 *
 * Stored per machine (localStorage), not in the project file, for the same
 * reason voxcpmSettings.ts is: a saved voice IS its reference clip, and that
 * clip lives in this machine's own media cache. Copying a project to another
 * machine would carry a name pointing at a path that isn't there, so the
 * project deliberately stores only the voice id it was assigned -- a missing
 * voice then reports itself instead of silently dubbing in someone else's. */

const STORAGE_KEY = 'creative-ai-editor.saved-custom-voices.v1'

export interface SavedCustomVoice {
  /** Stable id, also what a subtitle's `voiceId` refers to via
   * `savedVoiceId()` -- renaming a voice must not orphan every line already
   * assigned to it, so the name is never the key. */
  id: string
  name: string
  /** The prepared (mono 16-bit wav) reference clip -- see
   * app/main/media/voxcpmTts.ts's prepareReferenceClip. */
  referenceAudioPath: string
  createdAt: string
}

/** Namespaced so a saved voice can never collide with a catalog id from
 * voiceModels.ts, and so any code holding a `voiceId` can tell instantly
 * which of the two it has. */
const SAVED_PREFIX = 'saved:'

export function savedVoiceId(id: string): string {
  return `${SAVED_PREFIX}${id}`
}

export function isSavedVoiceId(voiceId: string): boolean {
  return voiceId.startsWith(SAVED_PREFIX)
}

export function savedVoiceIdToRaw(voiceId: string): string {
  return voiceId.startsWith(SAVED_PREFIX) ? voiceId.slice(SAVED_PREFIX.length) : voiceId
}

export function getSavedVoicesStorageKey(): string {
  return STORAGE_KEY
}

/** Tolerant on purpose: a corrupt or half-written entry drops out rather
 * than taking the whole list (and therefore every other saved voice) with
 * it. Same defensive shape as voxcpmSettings.ts's own parser. */
export function parseSavedVoices(raw: string | null): SavedCustomVoice[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidSavedVoice)
  } catch {
    return []
  }
}

function isValidSavedVoice(value: unknown): value is SavedCustomVoice {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<SavedCustomVoice>
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.referenceAudioPath === 'string' &&
    v.referenceAudioPath.length > 0 &&
    typeof v.createdAt === 'string'
  )
}

export function serializeSavedVoices(voices: SavedCustomVoice[]): string {
  return JSON.stringify(voices)
}

/** Adds a voice, or REPLACES the existing one of the same name (case- and
 * whitespace-insensitive) keeping its original id. Re-recording "Wang Lin"
 * should update that character's voice everywhere it's already assigned,
 * not leave two identically-named entries and make the user guess which
 * lines point at which. */
export function addSavedVoice(voices: SavedCustomVoice[], next: SavedCustomVoice): SavedCustomVoice[] {
  const key = normalizeName(next.name)
  const existing = voices.find((v) => normalizeName(v.name) === key)
  if (!existing) return [...voices, next]
  return voices.map((v) => (v.id === existing.id ? { ...next, id: existing.id } : v))
}

export function removeSavedVoice(voices: SavedCustomVoice[], id: string): SavedCustomVoice[] {
  return voices.filter((v) => v.id !== id)
}

export function findSavedVoice(voices: SavedCustomVoice[], voiceId: string): SavedCustomVoice | undefined {
  if (!isSavedVoiceId(voiceId)) return undefined
  const raw = savedVoiceIdToRaw(voiceId)
  return voices.find((v) => v.id === raw)
}

/** Built-in narrators: Microsoft Edge's two neural Khmer voices, spoken
 * over the internet by the app's own bundled Python (see
 * app/main/media/edgeTts.ts). No recording, no model, no GPU -- and, being
 * a fixed voice rather than a per-take clone, exactly the same voice and
 * pitch from the first sentence to the last. Ids carry their own prefix so
 * nothing ever mistakes one for a saved recording (`saved:`) or a catalog
 * card. */
const BUILTIN_PREFIX = 'edge:'

export interface BuiltinNarrator {
  /** Full voiceId, `edge:<edge voice name>`. */
  id: string
  name: string
  /** Shown under the name in the drawer. */
  hint: string
  edgeVoice: string
  /** The AI Dubber catalog card that maps to the same Edge voice, so
   * picking a built-in narrator can still pre-assign dubber lines. */
  dubberVoiceId: string
}

export const BUILTIN_NARRATORS: BuiltinNarrator[] = [
  { id: 'edge:km-KH-PisethNeural', name: 'Piseth', hint: 'Khmer male · built-in, online', edgeVoice: 'km-KH-PisethNeural', dubberVoiceId: 'khmer-narrator' },
  { id: 'edge:km-KH-SreymomNeural', name: 'Sreymom', hint: 'Khmer female · built-in, online', edgeVoice: 'km-KH-SreymomNeural', dubberVoiceId: 'khmer-female' }
]

export function isBuiltinNarratorId(voiceId: string): boolean {
  return voiceId.startsWith(BUILTIN_PREFIX)
}

export function findBuiltinNarrator(voiceId: string | null): BuiltinNarrator | undefined {
  return voiceId ? BUILTIN_NARRATORS.find((n) => n.id === voiceId) : undefined
}

/** The chosen narrator's display name, whichever kind it is. */
export function narratorDisplayName(voiceId: string | null): string | null {
  if (!voiceId) return null
  return findBuiltinNarrator(voiceId)?.name ?? findSavedVoice(loadSavedVoices(), voiceId)?.name ?? kiriVoiceOf(voiceId) ?? null
}

/** The voice chosen in Recap Script's My Voice drawer to narrate the
 * story: every new AI Dubber workspace starts with all lines assigned to
 * it, and picking it applies to the current workspace at once. Stored as
 * a full voiceId (`saved:<id>` or a built-in `edge:<voice>`), per machine
 * like the voices themselves. */
const NARRATOR_STORAGE_KEY = 'creative-ai-editor.story-narrator-voice.v1'

export function loadStoryNarratorVoiceId(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(NARRATOR_STORAGE_KEY)
    return raw && (isSavedVoiceId(raw) || !!findBuiltinNarrator(raw) || !!kiriVoiceOf(raw)) ? raw : null
  } catch {
    return null
  }
}

export function storeStoryNarratorVoiceId(voiceId: string | null): void {
  if (typeof localStorage !== 'undefined') {
    try {
      if (voiceId) localStorage.setItem(NARRATOR_STORAGE_KEY, voiceId)
      else localStorage.removeItem(NARRATOR_STORAGE_KEY)
    } catch {
      // Storage unavailable -- the choice still applies this session.
    }
  }
  for (const listener of narratorListeners) listener(voiceId)
}

type NarratorListener = (voiceId: string | null) => void
const narratorListeners = new Set<NarratorListener>()

/** The Recap Script header shows the chosen narrator's name; it lives in
 * a different component from the drawer that picks it, so it subscribes. */
export function subscribeStoryNarrator(listener: NarratorListener): () => void {
  narratorListeners.add(listener)
  return () => narratorListeners.delete(listener)
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** Reads the list, never throwing -- storage can be unavailable (private
 * mode, full quota) and a missing voice list must not take the panel down. */
export function loadSavedVoices(): SavedCustomVoice[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return parseSavedVoices(localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

type SavedVoicesListener = (voices: SavedCustomVoice[]) => void

/** Everywhere a voice can be picked -- the Voice Model grid, the Detect
 * Gender review, each subtitle row's dropdown -- reads this same list, and
 * they are siblings with no common owner between them. Rather than pushing
 * the list up into AiDubberContext (which would drag voice-picker UI state
 * into the workspace/generation model), storage writes announce themselves
 * here and each consumer re-reads. Saving a voice in one panel therefore
 * shows up in all of them, which is what "I saved it, where is it?" was. */
const listeners = new Set<SavedVoicesListener>()

export function subscribeSavedVoices(listener: SavedVoicesListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function storeSavedVoices(voices: SavedCustomVoice[]): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, serializeSavedVoices(voices))
    } catch {
      // Storage unavailable/full -- the in-memory list still works this session.
    }
  }
  for (const listener of listeners) listener(voices)
}
