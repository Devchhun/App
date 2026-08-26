import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Scene, SceneStatus } from '@shared/project'
import type { TemplateId } from '@shared/templates'
import { useAiSuggestions } from '../suggestions/AiSuggestionsContext'
import { syncScenesFromSuggestions } from './syncScenes'
import { defaultContentForTemplate } from '../templates/defaultContent'

interface SceneContextValue {
  scenesByMedia: Record<string, Scene[]>
  selectedSceneId: string | null
  selectScene: (sceneId: string | null) => void

  updateScene: (
    mediaId: string,
    sceneId: string,
    patch: Partial<
      Pick<
        Scene,
        | 'visualText'
        | 'reason'
        | 'templateId'
        | 'brandOverrides'
        | 'content'
        | 'icon'
        | 'presentationMode'
        | 'background'
        | 'contentTransform'
        | 'constrainToCanvas'
        | 'vaultConfig'
        | 'animatedVaultConfig'
        | 'dataCenterConfig'
        | 'hospitalResponseConfig'
        | 'position'
        | 'lockAspectRatio'
        | 'fontSizePx'
        | 'fontWeight'
        | 'textAlign'
        | 'textColor'
        | 'fillColor'
        | 'fillOpacity'
        | 'borderColor'
        | 'borderWidthPx'
        | 'borderRadiusPx'
        | 'animationPreset'
        | 'animationEasing'
        | 'animationDurationSeconds'
        | 'animationInDurationSeconds'
        | 'animationOutDurationSeconds'
        | 'motionPreset'
        | 'motionIntensity'
        | 'loopEnabled'
        | 'loopSpeed'
        | 'staggerDelay'
        | 'enterDuration'
        | 'exitDuration'
      >
    >
  ) => void
  retimeScene: (mediaId: string, sceneId: string, startTime: number, endTime: number) => void
  moveSceneToTrack: (mediaId: string, sceneId: string, track: string) => void
  toggleSceneLock: (mediaId: string, sceneId: string) => void
  toggleSceneLinked: (mediaId: string, sceneId: string) => void
  setSceneStatus: (mediaId: string, sceneId: string, status: SceneStatus) => void
  deleteScene: (mediaId: string, sceneId: string) => void
  duplicateScene: (mediaId: string, sceneId: string) => void
  bringSceneForward: (mediaId: string, sceneId: string) => void
  sendSceneBackward: (mediaId: string, sceneId: string) => void
  /** Splits a scene into two at `atTime` (a no-op if atTime isn't strictly inside the scene). Selects the new second half. */
  splitScene: (mediaId: string, sceneId: string, atTime: number) => void
  /** Timeline "Text" tool and Template Library "Add": inserts a new scene of
   * `templateId` (default lower-third) at `atTime` on `track`, positioned in
   * the safe area with a default 3s duration, selected immediately for editing. */
  insertScene: (mediaId: string, atTime: number, track: string, templateId?: TemplateId) => void
  /** Bulk-inserts every scene in one state update (and therefore one Undo
   * entry) -- the Local AI Scene Planner's "Apply" action builds each
   * accepted plan item into a real Scene (see
   * renderer/src/scenes/scenePlanToScenes.ts) and its own track routing
   * (see scenePlacementPlanning.ts) before calling this, mirroring
   * SequenceContext.insertPlannedClips's identical single-call shape for
   * multi-asset Timeline drops. Any newly-synthesized tracks must already
   * exist (via useSequence().ensureTrack) by the time this is called --
   * same division of responsibility as insertScene's own track argument. */
  insertScenes: (mediaId: string, scenes: Scene[]) => void

  setScenesForMedia: (mediaId: string, scenes: Scene[]) => void
  /** Bulk-replaces the whole scenesByMedia map -- used only by the undo/redo
   * history system to restore a past snapshot in one step (a single call, so
   * it produces one re-render instead of one per media id). */
  restoreScenesByMedia: (scenesByMedia: Record<string, Scene[]>) => void
}

const SceneContext = createContext<SceneContextValue | null>(null)

export function SceneProvider({ children }: { children: ReactNode }): JSX.Element {
  const { suggestionsByMedia } = useAiSuggestions()
  const [scenesByMedia, setScenesByMedia] = useState<Record<string, Scene[]>>({})
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)

  // Keep scenes in sync whenever accepted suggestions change (accept/reject,
  // edit, regenerate). Runs per media id so one media's edits don't touch another's.
  useEffect(() => {
    setScenesByMedia((prev) => {
      let changed = false
      const next: Record<string, Scene[]> = { ...prev }
      for (const [mediaId, suggestions] of Object.entries(suggestionsByMedia)) {
        const existing = prev[mediaId] ?? []
        const synced = syncScenesFromSuggestions(mediaId, existing, suggestions)
        if (synced !== existing) {
          next[mediaId] = synced
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [suggestionsByMedia])

  const selectScene = useCallback((sceneId: string | null) => setSelectedSceneId(sceneId), [])

  const updateScene = useCallback((mediaId: string, sceneId: string, patch: Partial<Scene>) => {
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === sceneId ? { ...s, ...patch, edited: true } : s))
    }))
  }, [])

  const retimeScene = useCallback((mediaId: string, sceneId: string, startTime: number, endTime: number) => {
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? [])
        .map((s) => (s.id === sceneId ? { ...s, startTime, endTime, edited: true } : s))
        .sort((a, b) => a.startTime - b.startTime)
    }))
  }, [])

  const moveSceneToTrack = useCallback((mediaId: string, sceneId: string, track: string) => {
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === sceneId ? { ...s, track, edited: true } : s))
    }))
  }, [])

  const toggleSceneLock = useCallback((mediaId: string, sceneId: string) => {
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === sceneId ? { ...s, locked: !s.locked } : s))
    }))
  }, [])

  const toggleSceneLinked = useCallback((mediaId: string, sceneId: string) => {
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === sceneId ? { ...s, linked: !(s.linked ?? true) } : s))
    }))
  }, [])

  const duplicateScene = useCallback((mediaId: string, sceneId: string) => {
    setScenesByMedia((prev) => {
      const list = prev[mediaId] ?? []
      const scene = list.find((s) => s.id === sceneId)
      if (!scene) return prev
      const copyId = crypto.randomUUID()
      const copy: Scene = {
        ...scene,
        id: copyId,
        suggestionId: `manual-${copyId}`,
        edited: true,
        locked: false,
        createdAt: new Date().toISOString()
      }
      setSelectedSceneId(copyId)
      return { ...prev, [mediaId]: [...list, copy].sort((a, b) => a.startTime - b.startTime) }
    })
  }, [])

  const bringSceneForward = useCallback((mediaId: string, sceneId: string) => {
    setScenesByMedia((prev) => {
      const list = prev[mediaId] ?? []
      const maxZ = Math.max(0, ...list.map((s) => s.zIndex ?? 0))
      return {
        ...prev,
        [mediaId]: list.map((s) => (s.id === sceneId ? { ...s, zIndex: maxZ + 1, edited: true } : s))
      }
    })
  }, [])

  const sendSceneBackward = useCallback((mediaId: string, sceneId: string) => {
    setScenesByMedia((prev) => {
      const list = prev[mediaId] ?? []
      const minZ = Math.min(0, ...list.map((s) => s.zIndex ?? 0))
      return {
        ...prev,
        [mediaId]: list.map((s) => (s.id === sceneId ? { ...s, zIndex: minZ - 1, edited: true } : s))
      }
    })
  }, [])

  const setSceneStatus = useCallback((mediaId: string, sceneId: string, status: SceneStatus) => {
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: (prev[mediaId] ?? []).map((s) => (s.id === sceneId ? { ...s, status } : s))
    }))
  }, [])

  const deleteScene = useCallback((mediaId: string, sceneId: string) => {
    setScenesByMedia((prev) => ({ ...prev, [mediaId]: (prev[mediaId] ?? []).filter((s) => s.id !== sceneId) }))
    setSelectedSceneId((prev) => (prev === sceneId ? null : prev))
  }, [])

  const splitScene = useCallback((mediaId: string, sceneId: string, atTime: number) => {
    setScenesByMedia((prev) => {
      const list = prev[mediaId] ?? []
      const scene = list.find((s) => s.id === sceneId)
      if (!scene || scene.locked || atTime <= scene.startTime || atTime >= scene.endTime) return prev
      const secondHalf: Scene = { ...scene, id: crypto.randomUUID(), startTime: atTime, edited: true }
      const firstHalf: Scene = { ...scene, endTime: atTime, edited: true }
      const next = list.map((s) => (s.id === sceneId ? firstHalf : s))
      next.push(secondHalf)
      next.sort((a, b) => a.startTime - b.startTime)
      setSelectedSceneId(secondHalf.id)
      return { ...prev, [mediaId]: next }
    })
  }, [])

  // Collision-avoidance now happens one level up, in the caller (see
  // TemplateBrowserPanel.tsx / TimelineToolbar.tsx), via trackModel.ts's
  // findOrCreateTrack -- which picks a genuinely free *track* (routing to a
  // new one if every existing graphic track is occupied at atTime) rather
  // than this pushing the new scene later in time on a fixed track. By the
  // time insertScene is called, `track`+`atTime` are already a valid,
  // non-overlapping placement.
  const insertScene = useCallback((mediaId: string, atTime: number, track: string, templateId: TemplateId = 'lower-third') => {
    const id = crypto.randomUUID()
    const defaults = defaultContentForTemplate(templateId, id)
    const duration = 3
    const startTime = Math.max(0, atTime)
    setScenesByMedia((prev) => {
      const scene: Scene = {
        id,
        mediaId,
        segmentId: '',
        suggestionId: `manual-${id}`,
        track,
        templateId,
        startTime,
        endTime: startTime + duration,
        purpose: 'main_claim',
        originalText: '',
        visualText: defaults?.visualText ?? 'New text',
        reason: 'Manually added',
        confidence: 1,
        locked: false,
        edited: true,
        status: 'accepted',
        createdAt: new Date().toISOString(),
        ...(defaults?.content ? { content: defaults.content } : {}),
        ...(defaults?.icon ? { icon: defaults.icon } : {}),
        ...(defaults?.presentationMode ? { presentationMode: defaults.presentationMode } : {}),
        ...(defaults?.background ? { background: defaults.background } : {})
      }
      return { ...prev, [mediaId]: [...(prev[mediaId] ?? []), scene].sort((a, b) => a.startTime - b.startTime) }
    })
    setSelectedSceneId(id)
  }, [])

  const insertScenes = useCallback((mediaId: string, scenes: Scene[]) => {
    if (scenes.length === 0) return
    setScenesByMedia((prev) => ({
      ...prev,
      [mediaId]: [...(prev[mediaId] ?? []), ...scenes].sort((a, b) => a.startTime - b.startTime)
    }))
  }, [])

  const setScenesForMedia = useCallback((mediaId: string, scenes: Scene[]) => {
    setScenesByMedia((prev) => ({ ...prev, [mediaId]: scenes }))
  }, [])

  const restoreScenesByMedia = useCallback((next: Record<string, Scene[]>) => {
    setScenesByMedia(next)
  }, [])

  const value = useMemo<SceneContextValue>(
    () => ({
      scenesByMedia,
      selectedSceneId,
      selectScene,
      updateScene,
      retimeScene,
      moveSceneToTrack,
      toggleSceneLock,
      toggleSceneLinked,
      setSceneStatus,
      deleteScene,
      duplicateScene,
      bringSceneForward,
      sendSceneBackward,
      splitScene,
      insertScene,
      insertScenes,
      setScenesForMedia,
      restoreScenesByMedia
    }),
    [
      scenesByMedia,
      selectedSceneId,
      selectScene,
      updateScene,
      retimeScene,
      moveSceneToTrack,
      toggleSceneLock,
      toggleSceneLinked,
      setSceneStatus,
      deleteScene,
      duplicateScene,
      bringSceneForward,
      sendSceneBackward,
      splitScene,
      insertScene,
      insertScenes,
      setScenesForMedia,
      restoreScenesByMedia
    ]
  )

  return <SceneContext.Provider value={value}>{children}</SceneContext.Provider>
}

export function useScenes(): SceneContextValue {
  const ctx = useContext(SceneContext)
  if (!ctx) throw new Error('useScenes must be used within SceneProvider')
  return ctx
}
