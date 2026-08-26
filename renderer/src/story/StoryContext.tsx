import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { StoryAnalysis, EntityBible, NarrativeEntity, VisualPlan, VisualPlanItem, VisualPlanItemStatus, StoryBeat, StorySceneGroup, StoryVisualTheme } from '@shared/story'
import { mergeStoryBeats, splitStoryBeat, type SegmentTimeLookup } from './storyBeatOps'
import { setThemeEntityColor } from './storyTheme'

interface StoryContextValue {
  narrativeGraphByMedia: Record<string, StoryAnalysis>
  entityBibleByMedia: Record<string, EntityBible>
  visualPlanByMedia: Record<string, VisualPlan>
  sceneGroups: StorySceneGroup[]
  /** The live, editable theme for each media item -- the Continuity panel
   * edits this directly; "Generate Accepted Graphics" snapshots the current
   * value into the new StorySceneGroup.theme it creates, matching how entity
   * colors get baked into individual scenes at that same moment. */
  themeByMedia: Record<string, StoryVisualTheme>

  /** Sets the analysis result for one media item, wholesale (a fresh "Analyze
   * Full Story" run). Does NOT touch the Entity Bible -- callers that also
   * want the bible seeded/merged from the new graph call
   * mergeEntitiesIntoBible separately, so a re-analysis never silently
   * clobbers user edits made after the previous run. */
  setNarrativeGraphForMedia: (mediaId: string, analysis: StoryAnalysis) => void

  /** Merges freshly-analyzed entities into this media's Entity Bible: a new
   * entity id is added as-is; an existing, LOCKED entity keeps its current
   * canonicalName/aliases/description/color/iconId/imageAssetId untouched
   * (only its `firstSegmentId`/`type` may still track the new analysis);
   * an existing, unlocked entity is fully replaced by the fresh one. Never
   * removes an entity the user already has that the new analysis simply
   * didn't mention again. */
  mergeEntitiesIntoBible: (mediaId: string, freshEntities: NarrativeEntity[]) => void
  updateEntity: (mediaId: string, entityId: string, patch: Partial<NarrativeEntity>) => void
  /** Merges `mergeId` into `keepId`: `keepId`'s aliases gain `mergeId`'s
   * canonicalName/aliases (deduplicated), then `mergeId` is removed from the
   * bible. Every relation/beat reference to `mergeId` is rewritten to
   * `keepId` across this media's visual plan so nothing is left dangling. */
  mergeEntities: (mediaId: string, keepId: string, mergeId: string) => void
  setEntityLocked: (mediaId: string, entityId: string, locked: boolean) => void

  setVisualPlanForMedia: (mediaId: string, plan: VisualPlan) => void
  setPlanItemStatus: (mediaId: string, beatId: string, status: VisualPlanItemStatus) => void
  /** Records that this plan item has been turned into a real Scene, so a
   * later "Generate Accepted Graphics" pass skips it instead of inserting a
   * duplicate. */
  markPlanItemGenerated: (mediaId: string, beatId: string, sceneId: string) => void
  editPlanItemBeat: (mediaId: string, beatId: string, patch: Partial<StoryBeat>) => void
  toggleplanItemLock: (mediaId: string, beatId: string) => void
  removePlanItem: (mediaId: string, beatId: string) => void
  /** Merges the plan item at `index` with the one immediately before it
   * (spec: "Merge with previous beat"). A no-op at index 0. */
  mergePlanItemWithPrevious: (mediaId: string, index: number) => void
  /** Splits the plan item at `index` into two at `atTime` (spec: "Split into
   * two beats"). `segmentTimes` supplies real transcript segment timing so
   * the split can partition segmentIds sensibly; see storyBeatOps.ts. */
  splitPlanItem: (mediaId: string, index: number, atTime: number, segmentTimes: SegmentTimeLookup) => void

  setSceneGroups: (groups: StorySceneGroup[]) => void
  addSceneGroup: (group: StorySceneGroup) => void
  updateSceneGroup: (groupId: string, patch: Partial<StorySceneGroup>) => void
  removeSceneGroup: (groupId: string) => void

  setThemeForMedia: (mediaId: string, theme: StoryVisualTheme) => void
  setThemeEntityColorForMedia: (mediaId: string, entityId: string, color: string) => void

  /** Bulk-replaces all five fields in one state update -- used only by the
   * undo/redo history system to restore a past snapshot in one step,
   * mirroring SceneContext's restoreScenesByMedia. */
  restoreStoryState: (snapshot: {
    narrativeGraphByMedia: Record<string, StoryAnalysis>
    entityBibleByMedia: Record<string, EntityBible>
    visualPlanByMedia: Record<string, VisualPlan>
    sceneGroups: StorySceneGroup[]
    themeByMedia: Record<string, StoryVisualTheme>
  }) => void
}

const StoryContext = createContext<StoryContextValue | null>(null)

function emptyBible(mediaId: string): EntityBible {
  return { id: crypto.randomUUID(), mediaId, entities: [], lockedEntityIds: [] }
}

export function StoryProvider({ children }: { children: ReactNode }): JSX.Element {
  const [narrativeGraphByMedia, setNarrativeGraphByMedia] = useState<Record<string, StoryAnalysis>>({})
  const [entityBibleByMedia, setEntityBibleByMedia] = useState<Record<string, EntityBible>>({})
  const [visualPlanByMedia, setVisualPlanByMedia] = useState<Record<string, VisualPlan>>({})
  const [sceneGroups, setSceneGroupsState] = useState<StorySceneGroup[]>([])
  const [themeByMedia, setThemeByMedia] = useState<Record<string, StoryVisualTheme>>({})

  const setNarrativeGraphForMedia = useCallback((mediaId: string, analysis: StoryAnalysis) => {
    setNarrativeGraphByMedia((prev) => ({ ...prev, [mediaId]: analysis }))
  }, [])

  const mergeEntitiesIntoBible = useCallback((mediaId: string, freshEntities: NarrativeEntity[]) => {
    setEntityBibleByMedia((prev) => {
      const existing = prev[mediaId] ?? emptyBible(mediaId)
      const locked = new Set(existing.lockedEntityIds)
      const byId = new Map(existing.entities.map((e) => [e.id, e]))
      for (const fresh of freshEntities) {
        if (locked.has(fresh.id)) {
          const current = byId.get(fresh.id)
          if (current) {
            byId.set(fresh.id, { ...current, type: fresh.type, firstSegmentId: fresh.firstSegmentId })
          } else {
            byId.set(fresh.id, fresh)
          }
        } else {
          byId.set(fresh.id, fresh)
        }
      }
      return { ...prev, [mediaId]: { ...existing, entities: [...byId.values()] } }
    })
  }, [])

  const updateEntity = useCallback((mediaId: string, entityId: string, patch: Partial<NarrativeEntity>) => {
    setEntityBibleByMedia((prev) => {
      const existing = prev[mediaId]
      if (!existing) return prev
      return {
        ...prev,
        [mediaId]: { ...existing, entities: existing.entities.map((e) => (e.id === entityId ? { ...e, ...patch, id: e.id } : e)) }
      }
    })
  }, [])

  const setEntityLocked = useCallback((mediaId: string, entityId: string, locked: boolean) => {
    setEntityBibleByMedia((prev) => {
      const existing = prev[mediaId]
      if (!existing) return prev
      const set = new Set(existing.lockedEntityIds)
      if (locked) set.add(entityId)
      else set.delete(entityId)
      return { ...prev, [mediaId]: { ...existing, lockedEntityIds: [...set] } }
    })
  }, [])

  const rewriteEntityIdInPlan = useCallback((mediaId: string, fromId: string, toId: string) => {
    setVisualPlanByMedia((prev) => {
      const plan = prev[mediaId]
      if (!plan) return prev
      const items = plan.items.map((item) => {
        if (!item.beat.entities.includes(fromId)) return item
        const entities = item.beat.entities.map((id) => (id === fromId ? toId : id))
        return { ...item, beat: { ...item.beat, entities: [...new Set(entities)] } }
      })
      return { ...prev, [mediaId]: { ...plan, items } }
    })
  }, [])

  const mergeEntities = useCallback(
    (mediaId: string, keepId: string, mergeId: string) => {
      if (keepId === mergeId) return
      setEntityBibleByMedia((prev) => {
        const existing = prev[mediaId]
        if (!existing) return prev
        const keep = existing.entities.find((e) => e.id === keepId)
        const merge = existing.entities.find((e) => e.id === mergeId)
        if (!keep || !merge) return prev
        const mergedAliases = [...new Set([...keep.aliases, merge.canonicalName, ...merge.aliases])]
        const entities = existing.entities.filter((e) => e.id !== mergeId).map((e) => (e.id === keepId ? { ...e, aliases: mergedAliases } : e))
        const lockedEntityIds = existing.lockedEntityIds.filter((id) => id !== mergeId)
        return { ...prev, [mediaId]: { ...existing, entities, lockedEntityIds } }
      })
      rewriteEntityIdInPlan(mediaId, mergeId, keepId)
    },
    [rewriteEntityIdInPlan]
  )

  const setVisualPlanForMedia = useCallback((mediaId: string, plan: VisualPlan) => {
    setVisualPlanByMedia((prev) => ({ ...prev, [mediaId]: plan }))
  }, [])

  const patchPlanItem = useCallback((mediaId: string, beatId: string, patch: Partial<VisualPlanItem>) => {
    setVisualPlanByMedia((prev) => {
      const plan = prev[mediaId]
      if (!plan) return prev
      return { ...prev, [mediaId]: { ...plan, items: plan.items.map((item) => (item.beat.id === beatId ? { ...item, ...patch } : item)) } }
    })
  }, [])

  const setPlanItemStatus = useCallback(
    (mediaId: string, beatId: string, status: VisualPlanItemStatus) => patchPlanItem(mediaId, beatId, { status }),
    [patchPlanItem]
  )

  const markPlanItemGenerated = useCallback((mediaId: string, beatId: string, sceneId: string) => {
    patchPlanItem(mediaId, beatId, { generatedSceneId: sceneId })
  }, [patchPlanItem])

  const editPlanItemBeat = useCallback(
    (mediaId: string, beatId: string, patch: Partial<StoryBeat>) => {
      setVisualPlanByMedia((prev) => {
        const plan = prev[mediaId]
        if (!plan) return prev
        return {
          ...prev,
          [mediaId]: { ...plan, items: plan.items.map((item) => (item.beat.id === beatId ? { ...item, beat: { ...item.beat, ...patch }, edited: true } : item)) }
        }
      })
    },
    []
  )

  const toggleplanItemLock = useCallback((mediaId: string, beatId: string) => {
    setVisualPlanByMedia((prev) => {
      const plan = prev[mediaId]
      if (!plan) return prev
      return { ...prev, [mediaId]: { ...plan, items: plan.items.map((item) => (item.beat.id === beatId ? { ...item, locked: !item.locked } : item)) } }
    })
  }, [])

  const removePlanItem = useCallback((mediaId: string, beatId: string) => {
    setVisualPlanByMedia((prev) => {
      const plan = prev[mediaId]
      if (!plan) return prev
      return { ...prev, [mediaId]: { ...plan, items: plan.items.filter((item) => item.beat.id !== beatId) } }
    })
  }, [])

  const mergePlanItemWithPrevious = useCallback((mediaId: string, index: number) => {
    if (index <= 0) return
    setVisualPlanByMedia((prev) => {
      const plan = prev[mediaId]
      if (!plan || index >= plan.items.length) return prev
      const prevItem = plan.items[index - 1]
      const curItem = plan.items[index]
      if (prevItem.locked || curItem.locked) return prev
      const merged = mergeStoryBeats(prevItem.beat, curItem.beat)
      const items = [...plan.items]
      items.splice(index - 1, 2, { beat: merged, status: 'proposed', edited: true, locked: false })
      return { ...prev, [mediaId]: { ...plan, items } }
    })
  }, [])

  const splitPlanItem = useCallback((mediaId: string, index: number, atTime: number, segmentTimes: SegmentTimeLookup) => {
    setVisualPlanByMedia((prev) => {
      const plan = prev[mediaId]
      if (!plan || index < 0 || index >= plan.items.length) return prev
      const target = plan.items[index]
      if (target.locked) return prev
      const halves = splitStoryBeat(target.beat, atTime, segmentTimes)
      if (!halves) return prev
      const [first, second] = halves
      const items = [...plan.items]
      items.splice(
        index,
        1,
        { beat: first, status: 'proposed', edited: true, locked: false },
        { beat: second, status: 'proposed', edited: true, locked: false }
      )
      return { ...prev, [mediaId]: { ...plan, items } }
    })
  }, [])

  const setSceneGroups = useCallback((groups: StorySceneGroup[]) => {
    setSceneGroupsState(groups)
  }, [])

  const addSceneGroup = useCallback((group: StorySceneGroup) => {
    setSceneGroupsState((prev) => [...prev, group])
  }, [])

  const updateSceneGroup = useCallback((groupId: string, patch: Partial<StorySceneGroup>) => {
    setSceneGroupsState((prev) => prev.map((g) => (g.id === groupId ? { ...g, ...patch } : g)))
  }, [])

  const removeSceneGroup = useCallback((groupId: string) => {
    setSceneGroupsState((prev) => prev.filter((g) => g.id !== groupId))
  }, [])

  const setThemeForMedia = useCallback((mediaId: string, theme: StoryVisualTheme) => {
    setThemeByMedia((prev) => ({ ...prev, [mediaId]: theme }))
  }, [])

  const setThemeEntityColorForMedia = useCallback((mediaId: string, entityId: string, color: string) => {
    setThemeByMedia((prev) => {
      const theme = prev[mediaId]
      if (!theme) return prev
      return { ...prev, [mediaId]: setThemeEntityColor(theme, entityId, color) }
    })
  }, [])

  const restoreStoryState = useCallback(
    (snapshot: {
      narrativeGraphByMedia: Record<string, StoryAnalysis>
      entityBibleByMedia: Record<string, EntityBible>
      visualPlanByMedia: Record<string, VisualPlan>
      sceneGroups: StorySceneGroup[]
      themeByMedia: Record<string, StoryVisualTheme>
    }) => {
      setNarrativeGraphByMedia(snapshot.narrativeGraphByMedia)
      setEntityBibleByMedia(snapshot.entityBibleByMedia)
      setVisualPlanByMedia(snapshot.visualPlanByMedia)
      setSceneGroupsState(snapshot.sceneGroups)
      setThemeByMedia(snapshot.themeByMedia)
    },
    []
  )

  const value = useMemo<StoryContextValue>(
    () => ({
      narrativeGraphByMedia,
      entityBibleByMedia,
      visualPlanByMedia,
      sceneGroups,
      themeByMedia,
      setNarrativeGraphForMedia,
      mergeEntitiesIntoBible,
      updateEntity,
      mergeEntities,
      setEntityLocked,
      setVisualPlanForMedia,
      setPlanItemStatus,
      markPlanItemGenerated,
      editPlanItemBeat,
      toggleplanItemLock,
      removePlanItem,
      mergePlanItemWithPrevious,
      splitPlanItem,
      setSceneGroups,
      addSceneGroup,
      updateSceneGroup,
      removeSceneGroup,
      setThemeForMedia,
      setThemeEntityColorForMedia,
      restoreStoryState
    }),
    [
      narrativeGraphByMedia,
      entityBibleByMedia,
      visualPlanByMedia,
      sceneGroups,
      themeByMedia,
      setNarrativeGraphForMedia,
      mergeEntitiesIntoBible,
      updateEntity,
      mergeEntities,
      setEntityLocked,
      setVisualPlanForMedia,
      setPlanItemStatus,
      markPlanItemGenerated,
      editPlanItemBeat,
      toggleplanItemLock,
      removePlanItem,
      mergePlanItemWithPrevious,
      splitPlanItem,
      setSceneGroups,
      addSceneGroup,
      updateSceneGroup,
      removeSceneGroup,
      setThemeForMedia,
      setThemeEntityColorForMedia,
      restoreStoryState
    ]
  )

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>
}

export function useStory(): StoryContextValue {
  const ctx = useContext(StoryContext)
  if (!ctx) throw new Error('useStory must be used within StoryProvider')
  return ctx
}
