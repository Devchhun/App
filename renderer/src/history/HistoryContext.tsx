import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Scene, BrandPreset, ProjectSequence } from '@shared/project'
import type { StoryAnalysis, EntityBible, VisualPlan, StorySceneGroup, StoryVisualTheme } from '@shared/story'
import { useScenes } from '../scenes/SceneContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useSequence } from '../sequence/SequenceContext'
import { useStory } from '../story/StoryContext'
import { createHistoryState, recordChange, beginTransaction, endTransaction, undoStep, redoStep, type HistoryState } from './historyReducer'

const MAX_HISTORY = 100

/** What one undo step restores. Deliberately narrow: only the pieces of
 * state the spec lists as undoable (Graphic Scenes + Timeline Sequence +
 * Brand Preset). Playback time, hover/selection state, loading progress, API
 * keys, media binaries, and other transient UI state are never part of this
 * shape, so they can never end up in history no matter what calls this
 * provider. */
interface HistorySnapshot {
  scenesByMedia: Record<string, Scene[]>
  sequence: ProjectSequence
  brandPreset: BrandPreset
  /** AI Connected Story Visualization state (see shared/story.ts) -- entity
   * edits, beat edits, theme changes, scene-group regeneration/reordering,
   * and lock/unlock all flow through this same undo/redo stack (spec
   * Section 12). One bulk generation/insertion (e.g. "Generate Accepted
   * Graphics", which touches both `scenesByMedia` above and `sceneGroups`
   * here) still lands as exactly one history entry, since both are part of
   * the same combined snapshot object. */
  narrativeGraphByMedia: Record<string, StoryAnalysis>
  entityBibleByMedia: Record<string, EntityBible>
  visualPlanByMedia: Record<string, VisualPlan>
  sceneGroups: StorySceneGroup[]
  themeByMedia: Record<string, StoryVisualTheme>
}

interface HistoryContextValue {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  /** Call at the start of a continuous session (pointer drag, focused text
   * field). Until the matching `endTransaction`, intermediate changes are
   * applied live but not recorded individually. */
  beginTransaction: () => void
  /** Call at the end of a continuous session (pointerup, blur, Enter, or a
   * debounce timeout). Records the whole session as exactly one history entry. */
  endTransaction: () => void
  /** Call right before writing state that came from LOADING data (a project
   * open, undo/redo's own restore), not from a user edit -- suppresses
   * exactly the next snapshot change from being recorded. Without this, the
   * project load's own async hydration (which lands after mount, so the
   * mount-time-only `initializedRef` guard doesn't cover it) gets recorded
   * as a spurious "undo back to empty" entry, corrupting the stack order for
   * every real edit that follows. */
  suppressNextRecord: () => void
}

const HistoryContext = createContext<HistoryContextValue | null>(null)

export function HistoryProvider({ children }: { children: ReactNode }): JSX.Element {
  const { scenesByMedia, restoreScenesByMedia } = useScenes()
  const { brandPreset, setBrandPreset } = useBrandPreset()
  const { sequence, restoreSequence } = useSequence()
  const { narrativeGraphByMedia, entityBibleByMedia, visualPlanByMedia, sceneGroups, themeByMedia, restoreStoryState } = useStory()

  const currentSnapshot = useMemo<HistorySnapshot>(
    () => ({ scenesByMedia, sequence, brandPreset, narrativeGraphByMedia, entityBibleByMedia, visualPlanByMedia, sceneGroups, themeByMedia }),
    [scenesByMedia, sequence, brandPreset, narrativeGraphByMedia, entityBibleByMedia, visualPlanByMedia, sceneGroups, themeByMedia]
  )

  const [historyState, setHistoryState] = useState<HistoryState<HistorySnapshot>>(() => createHistoryState())

  // Always holds the latest snapshot, updated synchronously every render --
  // lets endTransaction/undo/redo read the freshest value without a stale closure.
  const liveRef = useRef(currentSnapshot)
  liveRef.current = currentSnapshot

  // Same idea for historyState itself -- undo/redo read this instead of
  // using the setState-updater-function form, because calling OTHER
  // components' setState (restoreScenesByMedia/restoreSequence/setBrandPreset)
  // from INSIDE a setState updater is a real React footgun: an updater must
  // stay pure, and React is free to invoke/re-invoke it independently of a
  // normal render, which made the nested restore calls silently not commit
  // in some (non-reproducible-in-isolation, but real) sequences of edits.
  const historyStateRef = useRef(historyState)
  historyStateRef.current = historyState

  // Holds the last snapshot the watcher effect has already accounted for
  // (either recorded, or deliberately skipped mid-transaction).
  const lastRef = useRef(currentSnapshot)
  const applyingRef = useRef(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!initializedRef.current) {
      // Initial project load/hydration is not an undoable step.
      initializedRef.current = true
      lastRef.current = currentSnapshot
      return
    }
    if (applyingRef.current) {
      // This change came from undo()/redo() itself restoring a snapshot -- don't re-record it.
      applyingRef.current = false
      lastRef.current = currentSnapshot
      return
    }
    if (lastRef.current === currentSnapshot) return
    // Capture the OLD value into a local const before mutating the ref on
    // the next line -- setHistoryState's updater closure reads `lastRef`
    // lazily, and if React defers actually invoking this specific updater
    // (observed with certain native-event-triggered update batches), it
    // would otherwise read `lastRef.current` AFTER the reassignment below
    // already ran, recording "previous == current" (a no-op-looking entry)
    // instead of the real previous snapshot.
    const previousSnapshot = lastRef.current
    setHistoryState((s) => recordChange(s, previousSnapshot, MAX_HISTORY))
    lastRef.current = currentSnapshot
  }, [currentSnapshot])

  const beginTx = useCallback(() => {
    setHistoryState((s) => beginTransaction(s, lastRef.current))
  }, [])

  const endTx = useCallback(() => {
    setHistoryState((s) => endTransaction(s, liveRef.current, MAX_HISTORY))
    lastRef.current = liveRef.current
  }, [])

  const suppressNextRecord = useCallback(() => {
    applyingRef.current = true
  }, [])

  // Deliberately NOT using the setHistoryState(updater) form here: an
  // updater function must be pure, and calling other components' setState
  // (restoreScenesByMedia/restoreSequence/setBrandPreset) from inside one is
  // exactly the kind of impurity React warns against -- it can be invoked
  // independently of a matching render, and the nested restore calls could
  // silently fail to commit. Reading the current state via historyStateRef
  // and calling setHistoryState with a plain value keeps every one of these
  // as a sibling top-level setState call in the same event handler, which
  // React 18 batches together correctly.
  const undo = useCallback(() => {
    const step = undoStep(historyStateRef.current, liveRef.current)
    if (!step) return
    applyingRef.current = true
    restoreScenesByMedia(step.value.scenesByMedia)
    restoreSequence(step.value.sequence)
    setBrandPreset(step.value.brandPreset)
    restoreStoryState({
      narrativeGraphByMedia: step.value.narrativeGraphByMedia,
      entityBibleByMedia: step.value.entityBibleByMedia,
      visualPlanByMedia: step.value.visualPlanByMedia,
      sceneGroups: step.value.sceneGroups,
      themeByMedia: step.value.themeByMedia
    })
    lastRef.current = step.value
    setHistoryState(step.state)
  }, [restoreScenesByMedia, restoreSequence, setBrandPreset, restoreStoryState])

  const redo = useCallback(() => {
    const step = redoStep(historyStateRef.current, liveRef.current)
    if (!step) return
    applyingRef.current = true
    restoreScenesByMedia(step.value.scenesByMedia)
    restoreSequence(step.value.sequence)
    setBrandPreset(step.value.brandPreset)
    restoreStoryState({
      narrativeGraphByMedia: step.value.narrativeGraphByMedia,
      entityBibleByMedia: step.value.entityBibleByMedia,
      visualPlanByMedia: step.value.visualPlanByMedia,
      sceneGroups: step.value.sceneGroups,
      themeByMedia: step.value.themeByMedia
    })
    lastRef.current = step.value
    setHistoryState(step.state)
  }, [restoreScenesByMedia, restoreSequence, setBrandPreset, restoreStoryState])

  const value = useMemo<HistoryContextValue>(
    () => ({
      canUndo: historyState.past.length > 0,
      canRedo: historyState.future.length > 0,
      undo,
      redo,
      beginTransaction: beginTx,
      endTransaction: endTx,
      suppressNextRecord
    }),
    [historyState.past.length, historyState.future.length, undo, redo, beginTx, endTx, suppressNextRecord]
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isEditingText = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable
      if (isEditingText) return // let the browser's native field undo/redo run instead

      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}

export function useHistory(): HistoryContextValue {
  const ctx = useContext(HistoryContext)
  if (!ctx) throw new Error('useHistory must be used within HistoryProvider')
  return ctx
}
