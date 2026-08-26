import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CorrectionDictionaryEntry, CorrectionCategory } from '@shared/transcription'

interface CorrectionDictionaryContextValue {
  entries: CorrectionDictionaryEntry[]
  refresh: () => Promise<void>
  addEntry: (
    original: string,
    correction: string,
    category: CorrectionCategory,
    language: 'km' | 'en' | 'mixed'
  ) => Promise<void>
  updateEntry: (
    id: string,
    updates: Partial<Pick<CorrectionDictionaryEntry, 'original' | 'correction' | 'category' | 'language' | 'enabled'>>
  ) => Promise<void>
  removeEntry: (id: string) => Promise<void>
  exportToFile: () => Promise<{ canceled: boolean; filePath?: string }>
  importFromFile: (mode: 'merge' | 'replace') => Promise<{ canceled: boolean; count?: number }>
}

const CorrectionDictionaryContext = createContext<CorrectionDictionaryContextValue | null>(null)

export function CorrectionDictionaryProvider({ children }: { children: ReactNode }): JSX.Element {
  const [entries, setEntries] = useState<CorrectionDictionaryEntry[]>([])

  const refresh = useCallback(async () => {
    const list = await window.api.transcription.getCorrectionDictionary()
    setEntries(list)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addEntry = useCallback(
    async (original: string, correction: string, category: CorrectionCategory, language: 'km' | 'en' | 'mixed') => {
      await window.api.transcription.addCorrectionEntry(original, correction, category, language)
      await refresh()
    },
    [refresh]
  )

  const updateEntry = useCallback(
    async (
      id: string,
      updates: Partial<Pick<CorrectionDictionaryEntry, 'original' | 'correction' | 'category' | 'language' | 'enabled'>>
    ) => {
      await window.api.transcription.updateCorrectionEntry(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeEntry = useCallback(
    async (id: string) => {
      await window.api.transcription.removeCorrectionEntry(id)
      await refresh()
    },
    [refresh]
  )

  const exportToFile = useCallback(async () => {
    return window.api.transcription.exportCorrectionDictionaryToFile()
  }, [])

  const importFromFile = useCallback(
    async (mode: 'merge' | 'replace') => {
      const result = await window.api.transcription.importCorrectionDictionaryFromFile(mode)
      if (!result.canceled) await refresh()
      return { canceled: result.canceled, count: result.entries?.length }
    },
    [refresh]
  )

  const value = useMemo<CorrectionDictionaryContextValue>(
    () => ({ entries, refresh, addEntry, updateEntry, removeEntry, exportToFile, importFromFile }),
    [entries, refresh, addEntry, updateEntry, removeEntry, exportToFile, importFromFile]
  )

  return <CorrectionDictionaryContext.Provider value={value}>{children}</CorrectionDictionaryContext.Provider>
}

export function useCorrectionDictionary(): CorrectionDictionaryContextValue {
  const ctx = useContext(CorrectionDictionaryContext)
  if (!ctx) throw new Error('useCorrectionDictionary must be used within CorrectionDictionaryProvider')
  return ctx
}
