import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranscriptSegment } from '@shared/transcription'
import type { LocalAiHealth, LocalModelInfo, ModelPullProgress, LocalAiError, RejectedScenePlanScene, ScenePlanScene, ScenePlanGenerationOptions } from '@shared/localAi'
import { DEFAULT_SCENE_PLAN_OPTIONS } from '@shared/localAi'

export interface ScenePlanPreviewItem {
  scene: ScenePlanScene
  status: 'pending' | 'accepted' | 'rejected'
}

export type GenerationState = 'idle' | 'generating' | 'success' | 'canceled' | 'error'

interface LocalAiContextValue {
  health: LocalAiHealth | null
  refreshHealth: () => Promise<void>

  models: LocalModelInfo[]
  refreshModels: () => Promise<void>
  selectedModel: string | null
  setSelectedModel: (model: string) => void

  /** Quality controls (creativity/density/max simultaneous graphics/
   * preferred categories/min confidence) -- persisted per session, applied
   * to every `generate()` call until changed. */
  options: ScenePlanGenerationOptions
  setOptions: (patch: Partial<ScenePlanGenerationOptions>) => void

  /** Keyed by requestId -- a model can have more than one pull in flight
   * conceptually (retry after cancel), so the UI tracks by request, not by
   * model name alone. */
  pulls: Record<string, ModelPullProgress>
  startPull: (model: string) => string
  cancelPull: (requestId: string) => void
  retryPull: (requestId: string, model: string) => void
  unloadModel: (model: string) => Promise<void>

  generationState: GenerationState
  generationError: LocalAiError | null
  rejectedScenes: RejectedScenePlanScene[]
  previewItems: ScenePlanPreviewItem[]
  currentMediaId: string | null
  generate: (mediaId: string, segments: TranscriptSegment[], mediaDurationSeconds: number) => Promise<void>
  cancelGenerate: () => void
  setSceneStatus: (sceneId: string, status: 'accepted' | 'rejected' | 'pending') => void
  setAllScenesStatus: (status: 'accepted' | 'rejected') => void
  editScene: (sceneId: string, patch: Partial<Pick<ScenePlanScene, 'content' | 'templateId' | 'startTime' | 'endTime'>>) => void
  clearPreview: () => void
}

const LocalAiContext = createContext<LocalAiContextValue | null>(null)

export function LocalAiProvider({ children }: { children: ReactNode }): JSX.Element {
  const [health, setHealth] = useState<LocalAiHealth | null>(null)
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [pulls, setPulls] = useState<Record<string, ModelPullProgress>>({})
  const [options, setOptionsState] = useState<ScenePlanGenerationOptions>(DEFAULT_SCENE_PLAN_OPTIONS)
  const setOptions = useCallback((patch: Partial<ScenePlanGenerationOptions>) => {
    setOptionsState((prev) => ({ ...prev, ...patch }))
  }, [])

  const [generationState, setGenerationState] = useState<GenerationState>('idle')
  const [generationError, setGenerationError] = useState<LocalAiError | null>(null)
  const [rejectedScenes, setRejectedScenes] = useState<RejectedScenePlanScene[]>([])
  const [previewItems, setPreviewItems] = useState<ScenePlanPreviewItem[]>([])
  const [currentMediaId, setCurrentMediaId] = useState<string | null>(null)
  const currentRequestId = useRef<string | null>(null)

  const refreshHealth = useCallback(async () => {
    const result = await window.api.localAi.getHealth()
    setHealth(result)
  }, [])

  const refreshModels = useCallback(async () => {
    const result = await window.api.localAi.listModels()
    if (result.ok) {
      setModels(result.data)
      setSelectedModel((prev) => prev ?? result.data.find((m) => m.installed)?.id ?? null)
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
    void refreshModels()
  }, [refreshHealth, refreshModels])

  useEffect(() => {
    return window.api.localAi.onPullProgress((p) => {
      setPulls((prev) => ({ ...prev, [p.requestId]: p }))
      if (p.status === 'success') void refreshModels()
    })
  }, [refreshModels])

  const startPull = useCallback((model: string): string => {
    const requestId = crypto.randomUUID()
    setPulls((prev) => ({ ...prev, [requestId]: { requestId, model, percent: 0, status: 'pulling' } }))
    void window.api.localAi.pullModel(requestId, model)
    return requestId
  }, [])

  const cancelPull = useCallback((requestId: string) => {
    void window.api.localAi.cancelPull(requestId)
  }, [])

  const retryPull = useCallback((requestId: string, model: string) => {
    setPulls((prev) => ({ ...prev, [requestId]: { requestId, model, percent: 0, status: 'pulling' } }))
    void window.api.localAi.retryPull(requestId, model)
  }, [])

  const unloadModel = useCallback(async (model: string) => {
    await window.api.localAi.unloadModel(model)
    await refreshModels()
  }, [refreshModels])

  const generate = useCallback(async (mediaId: string, segments: TranscriptSegment[], mediaDurationSeconds: number) => {
    if (!selectedModel) {
      setGenerationState('error')
      setGenerationError({ kind: 'model-not-found', message: 'No model selected.' })
      return
    }
    const requestId = crypto.randomUUID()
    currentRequestId.current = requestId
    setCurrentMediaId(mediaId)
    setGenerationState('generating')
    setGenerationError(null)
    setPreviewItems([])
    setRejectedScenes([])

    const result = await window.api.localAi.generateScenePlan(requestId, mediaId, segments, mediaDurationSeconds, selectedModel, options)
    if (currentRequestId.current !== requestId) return // a newer request superseded this one

    if (!result.ok) {
      setGenerationState(result.error.kind === 'canceled' ? 'canceled' : 'error')
      setGenerationError(result.error)
      return
    }
    setGenerationState('success')
    setRejectedScenes(result.data.rejectedScenes)
    setPreviewItems(result.data.plan.scenes.map((scene) => ({ scene, status: 'pending' as const })))
  }, [selectedModel, options])

  const cancelGenerate = useCallback(() => {
    if (currentRequestId.current) void window.api.localAi.cancelGenerate(currentRequestId.current)
  }, [])

  const setSceneStatus = useCallback((sceneId: string, status: 'accepted' | 'rejected' | 'pending') => {
    setPreviewItems((prev) => prev.map((item) => (item.scene.id === sceneId ? { ...item, status } : item)))
  }, [])

  const setAllScenesStatus = useCallback((status: 'accepted' | 'rejected') => {
    setPreviewItems((prev) => prev.map((item) => ({ ...item, status })))
  }, [])

  const editScene = useCallback((sceneId: string, patch: Partial<Pick<ScenePlanScene, 'content' | 'templateId' | 'startTime' | 'endTime'>>) => {
    setPreviewItems((prev) => prev.map((item) => (item.scene.id === sceneId ? { ...item, scene: { ...item.scene, ...patch } } : item)))
  }, [])

  const clearPreview = useCallback(() => {
    setPreviewItems([])
    setRejectedScenes([])
    setGenerationState('idle')
    setGenerationError(null)
    setCurrentMediaId(null)
    currentRequestId.current = null
  }, [])

  const value = useMemo<LocalAiContextValue>(
    () => ({
      health,
      refreshHealth,
      models,
      refreshModels,
      selectedModel,
      setSelectedModel,
      options,
      setOptions,
      pulls,
      startPull,
      cancelPull,
      retryPull,
      unloadModel,
      generationState,
      generationError,
      rejectedScenes,
      previewItems,
      currentMediaId,
      generate,
      cancelGenerate,
      setSceneStatus,
      setAllScenesStatus,
      editScene,
      clearPreview
    }),
    [
      health,
      refreshHealth,
      models,
      refreshModels,
      selectedModel,
      pulls,
      startPull,
      cancelPull,
      retryPull,
      unloadModel,
      generationState,
      generationError,
      rejectedScenes,
      previewItems,
      currentMediaId,
      generate,
      cancelGenerate,
      setSceneStatus,
      setAllScenesStatus,
      editScene,
      clearPreview
    ]
  )

  return <LocalAiContext.Provider value={value}>{children}</LocalAiContext.Provider>
}

export function useLocalAi(): LocalAiContextValue {
  const ctx = useContext(LocalAiContext)
  if (!ctx) throw new Error('useLocalAi must be used within LocalAiProvider')
  return ctx
}
