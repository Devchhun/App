import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AiSuggestion, CloudRequestPreview, GenerationState, GenerateSuggestionsError, SuggestionStatus } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'
import { partitionSegmentsForRegeneration, mergeSuggestions, spliceSuggestion } from './mergeSuggestions'

interface AiSuggestionsContextValue {
  hasApiKey: boolean
  refreshApiKeyStatus: () => Promise<void>
  saveApiKey: (key: string) => Promise<void>
  clearApiKey: () => Promise<void>

  suggestionsByMedia: Record<string, AiSuggestion[]>
  generationState: GenerationState
  lastError: GenerateSuggestionsError | null
  lastResultFromCache: boolean

  previewCloudRequest: (segments: TranscriptSegment[]) => Promise<CloudRequestPreview>
  generate: (mediaId: string, segments: TranscriptSegment[], forceRegenerate?: boolean) => Promise<void>
  cancel: () => void
  retry: (mediaId: string, segments: TranscriptSegment[]) => Promise<void>

  regenerateOne: (mediaId: string, segment: TranscriptSegment) => Promise<void>
  simplify: (mediaId: string, suggestionId: string) => Promise<void>

  updateSuggestionText: (mediaId: string, suggestionId: string, updates: { visualText?: string; reason?: string }) => void
  setSuggestionStatus: (mediaId: string, suggestionId: string, status: SuggestionStatus) => void
  toggleLock: (mediaId: string, suggestionId: string) => void
  deleteSuggestion: (mediaId: string, suggestionId: string) => void
  undoDelete: (mediaId: string) => void
  canUndoDelete: (mediaId: string) => boolean

  setSuggestionsForMedia: (mediaId: string, suggestions: AiSuggestion[]) => void
}

const AiSuggestionsContext = createContext<AiSuggestionsContextValue | null>(null)

export function AiSuggestionsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [hasApiKey, setHasApiKey] = useState(false)
  const [suggestionsByMedia, setSuggestionsByMedia] = useState<Record<string, AiSuggestion[]>>({})
  const [generationState, setGenerationState] = useState<GenerationState>('idle')
  const [lastError, setLastError] = useState<GenerateSuggestionsError | null>(null)
  const [lastResultFromCache, setLastResultFromCache] = useState(false)

  const currentRequestId = useRef<string | null>(null)
  // One-level undo stack per media, holding the full list as it was right before a delete.
  const deleteUndoStack = useRef<Record<string, AiSuggestion[]>>({})
  // Ref mirror so callbacks that need a stable identity (e.g. simplify) can read current state without depending on it.
  const suggestionsByMediaRef = useRef(suggestionsByMedia)
  suggestionsByMediaRef.current = suggestionsByMedia

  const refreshApiKeyStatus = useCallback(async () => {
    setHasApiKey(await window.api.ai.hasApiKey())
  }, [])

  useEffect(() => {
    void refreshApiKeyStatus()
  }, [refreshApiKeyStatus])

  const saveApiKey = useCallback(
    async (key: string) => {
      await window.api.ai.setApiKey(key)
      await refreshApiKeyStatus()
    },
    [refreshApiKeyStatus]
  )

  const clearApiKey = useCallback(async () => {
    await window.api.ai.clearApiKey()
    await refreshApiKeyStatus()
  }, [refreshApiKeyStatus])

  const previewCloudRequest = useCallback(async (segments: TranscriptSegment[]) => {
    return window.api.ai.previewCloudRequest(segments)
  }, [])

  const generate = useCallback(
    async (mediaId: string, segments: TranscriptSegment[], forceRegenerate = false) => {
      const existing = suggestionsByMedia[mediaId] ?? []
      const { toPreserve, toClassify } = partitionSegmentsForRegeneration(segments, existing)

      setGenerationState('generating')
      setLastError(null)
      const requestId = crypto.randomUUID()
      currentRequestId.current = requestId

      try {
        if (toClassify.length === 0) {
          // Everything is already preserved (accepted/locked/edited) -- no API call needed at all.
          setSuggestionsByMedia((prev) => ({ ...prev, [mediaId]: mergeSuggestions(toPreserve, []) }))
          setGenerationState('success')
          setLastResultFromCache(false)
          return
        }

        const result = await window.api.ai.generateSuggestions(requestId, mediaId, toClassify, forceRegenerate)
        if (currentRequestId.current !== requestId) return // superseded by a newer request

        if (!result.ok) {
          if (result.error.kind === 'canceled') {
            setGenerationState('canceled')
          } else if (result.error.kind === 'rate-limit') {
            setGenerationState('rate-limited')
          } else {
            setGenerationState('error')
          }
          setLastError(result.error)
          return
        }

        setSuggestionsByMedia((prev) => ({
          ...prev,
          [mediaId]: mergeSuggestions(toPreserve, result.data.suggestions)
        }))
        setLastResultFromCache(result.data.fromCache)
        setGenerationState('success')
      } finally {
        if (currentRequestId.current === requestId) currentRequestId.current = null
      }
    },
    [suggestionsByMedia]
  )

  const cancel = useCallback(() => {
    if (!currentRequestId.current) return
    void window.api.ai.cancelRequest(currentRequestId.current)
  }, [])

  const retry = useCallback(
    async (mediaId: string, segments: TranscriptSegment[]) => {
      await generate(mediaId, segments, false)
    },
    [generate]
  )

  const regenerateOne = useCallback(async (mediaId: string, segment: TranscriptSegment) => {
    const requestId = crypto.randomUUID()
    currentRequestId.current = requestId
    setGenerationState('generating')
    setLastError(null)
    try {
      const result = await window.api.ai.regenerateSuggestion(requestId, mediaId, segment)
      if (!result.ok) {
        setGenerationState(result.error.kind === 'canceled' ? 'canceled' : result.error.kind === 'rate-limit' ? 'rate-limited' : 'error')
        setLastError(result.error)
        return
      }
      if (result.data) {
        setSuggestionsByMedia((prev) => ({ ...prev, [mediaId]: spliceSuggestion(prev[mediaId] ?? [], result.data as AiSuggestion) }))
      }
      setGenerationState('success')
    } finally {
      if (currentRequestId.current === requestId) currentRequestId.current = null
    }
  }, [])

  const simplify = useCallback(async (mediaId: string, suggestionId: string) => {
    const list = suggestionsByMediaRef.current[mediaId]
    const target = list?.find((s) => s.id === suggestionId)
    if (!target) return

    const requestId = crypto.randomUUID()
    currentRequestId.current = requestId
    setGenerationState('generating')
    setLastError(null)
    try {
      const result = await window.api.ai.simplifySuggestion(requestId, target.visualText)
      if (!result.ok) {
        setGenerationState(result.error.kind === 'canceled' ? 'canceled' : result.error.kind === 'rate-limit' ? 'rate-limited' : 'error')
        setLastError(result.error)
        return
      }
      setSuggestionsByMedia((prev) => ({
        ...prev,
        [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === suggestionId ? { ...s, visualText: result.data, edited: true } : s))
      }))
      setGenerationState('success')
    } finally {
      if (currentRequestId.current === requestId) currentRequestId.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateSuggestionText = useCallback(
    (mediaId: string, suggestionId: string, updates: { visualText?: string; reason?: string }) => {
      setSuggestionsByMedia((prev) => ({
        ...prev,
        [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === suggestionId ? { ...s, ...updates, edited: true } : s))
      }))
    },
    []
  )

  const setSuggestionStatus = useCallback((mediaId: string, suggestionId: string, status: SuggestionStatus) => {
    setSuggestionsByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === suggestionId ? { ...s, status } : s))
    }))
  }, [])

  const toggleLock = useCallback((mediaId: string, suggestionId: string) => {
    setSuggestionsByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === suggestionId ? { ...s, locked: !s.locked } : s))
    }))
  }, [])

  const deleteSuggestion = useCallback((mediaId: string, suggestionId: string) => {
    setSuggestionsByMedia((prev) => {
      const list = prev[mediaId] ?? []
      deleteUndoStack.current[mediaId] = list
      return { ...prev, [mediaId]: list.filter((s) => s.id !== suggestionId) }
    })
  }, [])

  const undoDelete = useCallback((mediaId: string) => {
    const snapshot = deleteUndoStack.current[mediaId]
    if (!snapshot) return
    setSuggestionsByMedia((prev) => ({ ...prev, [mediaId]: snapshot }))
    delete deleteUndoStack.current[mediaId]
  }, [])

  const canUndoDelete = useCallback((mediaId: string) => mediaId in deleteUndoStack.current, [])

  const setSuggestionsForMedia = useCallback((mediaId: string, suggestions: AiSuggestion[]) => {
    setSuggestionsByMedia((prev) => ({ ...prev, [mediaId]: suggestions }))
  }, [])

  const value = useMemo<AiSuggestionsContextValue>(
    () => ({
      hasApiKey,
      refreshApiKeyStatus,
      saveApiKey,
      clearApiKey,
      suggestionsByMedia,
      generationState,
      lastError,
      lastResultFromCache,
      previewCloudRequest,
      generate,
      cancel,
      retry,
      regenerateOne,
      simplify,
      updateSuggestionText,
      setSuggestionStatus,
      toggleLock,
      deleteSuggestion,
      undoDelete,
      canUndoDelete,
      setSuggestionsForMedia
    }),
    [
      hasApiKey,
      refreshApiKeyStatus,
      saveApiKey,
      clearApiKey,
      suggestionsByMedia,
      generationState,
      lastError,
      lastResultFromCache,
      previewCloudRequest,
      generate,
      cancel,
      retry,
      regenerateOne,
      simplify,
      updateSuggestionText,
      setSuggestionStatus,
      toggleLock,
      deleteSuggestion,
      undoDelete,
      canUndoDelete,
      setSuggestionsForMedia
    ]
  )

  return <AiSuggestionsContext.Provider value={value}>{children}</AiSuggestionsContext.Provider>
}

export function useAiSuggestions(): AiSuggestionsContextValue {
  const ctx = useContext(AiSuggestionsContext)
  if (!ctx) throw new Error('useAiSuggestions must be used within AiSuggestionsProvider')
  return ctx
}
