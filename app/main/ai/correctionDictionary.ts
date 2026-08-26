import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { CorrectionDictionaryEntry, CorrectionCategory } from '@shared/transcription'

// Deliberately stored at the user-install level (not inside a project file):
// spec calls for corrections to persist across projects on this machine.
function dictionaryPath(): string {
  return join(app.getPath('userData'), 'correction-dictionary.json')
}

async function readAll(): Promise<CorrectionDictionaryEntry[]> {
  try {
    const raw = JSON.parse(await readFile(dictionaryPath(), 'utf-8')) as Array<
      Partial<CorrectionDictionaryEntry> & Omit<CorrectionDictionaryEntry, 'enabled'>
    >
    // Entries written before `enabled` existed default to enabled.
    return raw.map((e) => ({ ...e, enabled: e.enabled ?? true }))
  } catch {
    return []
  }
}

async function writeAllAtomic(entries: CorrectionDictionaryEntry[]): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmpPath = `${dictionaryPath()}.tmp`
  // UTF-8 by default; explicit here since Khmer text correctness depends on it.
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8')
  await rename(tmpPath, dictionaryPath())
}

export async function getCorrectionDictionary(): Promise<CorrectionDictionaryEntry[]> {
  return readAll()
}

export async function addCorrectionEntry(
  original: string,
  correction: string,
  category: CorrectionCategory,
  language: 'km' | 'en' | 'mixed'
): Promise<CorrectionDictionaryEntry> {
  const entries = await readAll()
  const existing = entries.find((e) => e.original === original)
  if (existing) {
    existing.correction = correction
    existing.category = category
    existing.language = language
    await writeAllAtomic(entries)
    return existing
  }
  const entry: CorrectionDictionaryEntry = {
    id: randomUUID(),
    original,
    correction,
    category,
    language,
    enabled: true,
    createdAt: new Date().toISOString(),
    timesApplied: 0
  }
  entries.push(entry)
  await writeAllAtomic(entries)
  return entry
}

export async function updateCorrectionEntry(
  id: string,
  updates: Partial<Pick<CorrectionDictionaryEntry, 'original' | 'correction' | 'category' | 'language' | 'enabled'>>
): Promise<CorrectionDictionaryEntry | null> {
  const entries = await readAll()
  const entry = entries.find((e) => e.id === id)
  if (!entry) return null
  Object.assign(entry, updates)
  await writeAllAtomic(entries)
  return entry
}

export async function removeCorrectionEntry(id: string): Promise<void> {
  const entries = await readAll()
  await writeAllAtomic(entries.filter((e) => e.id !== id))
}

export async function incrementTimesApplied(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const entries = await readAll()
  const idSet = new Set(ids)
  for (const entry of entries) {
    if (idSet.has(entry.id)) entry.timesApplied += 1
  }
  await writeAllAtomic(entries)
}

export async function importCorrectionDictionary(
  jsonText: string,
  mode: 'merge' | 'replace'
): Promise<CorrectionDictionaryEntry[]> {
  const imported = JSON.parse(jsonText) as CorrectionDictionaryEntry[]
  if (!Array.isArray(imported)) throw new Error('Dictionary file must contain a JSON array of entries')

  const normalized: CorrectionDictionaryEntry[] = imported.map((e) => ({
    id: e.id || randomUUID(),
    original: String(e.original ?? ''),
    correction: String(e.correction ?? ''),
    category: (e.category as CorrectionCategory) ?? 'other',
    language: e.language ?? 'mixed',
    enabled: e.enabled ?? true,
    createdAt: e.createdAt ?? new Date().toISOString(),
    timesApplied: e.timesApplied ?? 0
  }))

  if (mode === 'replace') {
    await writeAllAtomic(normalized)
    return normalized
  }

  const existing = await readAll()
  const byOriginal = new Map(existing.map((e) => [e.original, e]))
  for (const entry of normalized) {
    byOriginal.set(entry.original, entry)
  }
  const merged = Array.from(byOriginal.values())
  await writeAllAtomic(merged)
  return merged
}

export async function exportCorrectionDictionaryJson(): Promise<string> {
  const entries = await readAll()
  return JSON.stringify(entries, null, 2)
}
