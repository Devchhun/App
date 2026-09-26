import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useAiSuggestions } from '../suggestions/AiSuggestionsContext'
import { useScenes } from '../scenes/SceneContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { useStory } from '../story/StoryContext'
import { useNarration } from '../narration/NarrationContext'
import { useAiDubber } from '../dubbing/AiDubberContext'
import type { ProjectFile, MediaSource, Scene } from '@shared/project'
import { withoutTransientDubbingState } from '@shared/dubbing'
import { pendingStageFor } from './pendingStage'
import { markHomeSeen } from '../home/homeSession'

interface ProjectContextValue {
  projectId: string | null
  projectName: string | null
  lastSavedAt: string | null
  /** Where the project file lives on disk -- known once the first save
   * (or the startup load's own path) has reported it. */
  projectPath: string | null
  createdAt: string | null
  privacyMode: ProjectFile['privacyMode'] | null
  renameProject: (name: string) => void
  /** Timeline > Cover: the PNG the app just wrote becomes the project's
   * cover (see ProjectFile.coverPath). */
  setCover: (path: string) => void
  /** Home screen: make another project (or a new one) the one to reopen,
   * then reload the window so every provider hydrates from it. Flushes a
   * pending autosave of the current project first. */
  switchProject: (id: string | 'new') => Promise<void>
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

const AUTOSAVE_DEBOUNCE_MS = 3000

export function ProjectProvider({ children }: { children: ReactNode }): JSX.Element {
  const { items, hydrateFromSaved, select: selectMedia } = useMedia()
  const { transcripts, scriptAlignments, scriptTexts, hydrateFromSaved: hydrateTranscriptsFromSaved } = useTranscript()
  const { suggestionsByMedia, setSuggestionsForMedia } = useAiSuggestions()
  const { scenesByMedia, setScenesForMedia } = useScenes()
  const { brandPreset, setBrandPreset } = useBrandPreset()
  const { sequence, restoreSequence } = useSequence()
  const { suppressNextRecord } = useHistory()
  const { narrativeGraphByMedia, entityBibleByMedia, visualPlanByMedia, sceneGroups, themeByMedia, restoreStoryState } = useStory()
  const { state: narrationState, restore: restoreNarrationWorkspace } = useNarration()
  const { state: dubbingState, restore: restoreDubbingWorkspace } = useAiDubber()
  const [project, setProject] = useState<ProjectFile | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNextSave = useRef(true)
  /** The save the debounce is currently waiting to run, so closing the
   * window can run it NOW. Without this the effect cleanup below just
   * cancelled the pending timer on unmount -- anything changed in the last
   * AUTOSAVE_DEBOUNCE_MS before quitting silently never reached disk. */
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const flush = (): void => {
      if (saveTimer.current !== null && pendingSaveRef.current) {
        clearTimeout(saveTimer.current)
        pendingSaveRef.current()
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])
  // True for the whole span between `setProject(loaded)` and the LAST
  // restore call below -- `restoreSequence`/`setBrandPreset`/`hydrateFromSaved`/
  // etc. each set their own independent piece of state, and `hydrateFromSaved`
  // in particular only happens after an awaited IPC round-trip. Each of those
  // is its own React commit, so the autosave effect below (which depends on
  // all of them) re-runs several times DURING loading, with only SOME of the
  // loaded data applied so far -- e.g. `project` already the real loaded
  // project while `sequence` is still SequenceContext's pre-load empty
  // default. Gating the autosave effect on this ref (checked before the old
  // "skip the first run" logic) stops any of those in-between renders from
  // ever scheduling a save -- previously, with only a first-run guard, one of
  // those partial-state renders could be the one whose debounced save
  // actually fired (if the app happened to close/reload again within the
  // 3s window before a later, more-complete render rescheduled it), silently
  // overwriting the real saved sequence/tracks with whatever was still at
  // its default. Confirmed happening in practice, not just theoretical.
  const isLoadingProject = useRef(true)

  // Reopen the most recent project on launch (or create one), per the
  // "reopen latest project after an unexpected shutdown" requirement.
  useEffect(() => {
    window.api.project.getOrCreateStartup().then(async (loaded) => {
      setProject(loaded)
      if (loaded.media.length > 0) {
        const rehydrated = await window.api.media.rehydrate(loaded.media)
        hydrateFromSaved(rehydrated)
      }
      hydrateTranscriptsFromSaved(loaded.transcripts ?? {}, loaded.scriptAlignments ?? {})
      for (const [mediaId, suggestions] of Object.entries(loaded.aiSuggestions ?? {})) {
        setSuggestionsForMedia(mediaId, suggestions)
      }
      const scenesByLoadedMedia: Record<string, Scene[]> = {}
      for (const scene of loaded.scenes ?? []) {
        ;(scenesByLoadedMedia[scene.mediaId] ??= []).push(scene)
      }
      // This whole batch (scenes/sequence/brandPreset/story state) is data
      // LOADING, not a user edit -- HistoryContext's mount-time-only
      // initializedRef guard doesn't cover it, since this async .then()
      // lands after mount. Without this, it gets recorded as a spurious
      // "undo back to empty" entry that corrupts the stack order for every
      // real edit afterward.
      suppressNextRecord()
      for (const [mediaId, scenes] of Object.entries(scenesByLoadedMedia)) {
        setScenesForMedia(mediaId, scenes)
      }
      restoreSequence(loaded.sequence)
      setBrandPreset(loaded.brandPreset)
      restoreStoryState({
        narrativeGraphByMedia: loaded.narrativeGraph ?? {},
        entityBibleByMedia: loaded.entityBible ?? {},
        visualPlanByMedia: loaded.visualPlan ?? {},
        sceneGroups: loaded.sceneGroups ?? [],
        themeByMedia: loaded.theme ?? {}
      })
      if (loaded.narrationWorkspace) restoreNarrationWorkspace(loaded.narrationWorkspace)
      if (loaded.dubbingWorkspace) restoreDubbingWorkspace(loaded.dubbingWorkspace)

      // Re-select the video the user was working on. Which media is
      // selected is not part of the project file, so on reopen nothing was
      // -- and the Timeline's caption track draws the SELECTED media's
      // subtitles, so every reopen came up with the SRT captions gone from
      // the Timeline even though the transcript itself had saved fine
      // ("subtitles disappear when I close the app"). Best signal available
      // is whichever video a dubbing/narration workspace is bound to, then
      // the video actually sitting on the main track.
      const loadedIds = new Set(loaded.media.map((m) => m.id))
      const mainTrackId = loaded.sequence.tracks.find((t) => t.isMain)?.id
      const mainClipMediaId = mainTrackId ? loaded.sequence.clips.find((c) => c.trackId === mainTrackId)?.mediaId : undefined
      const reselect = [loaded.dubbingWorkspace?.videoMediaId, loaded.narrationWorkspace?.videoMediaId, mainClipMediaId].find(
        (id): id is string => !!id && loadedIds.has(id)
      )
      if (reselect) selectMedia(reselect)

      // Only NOW is every piece of loaded state actually applied -- see
      // isLoadingProject's own doc comment for why this must be the very
      // last thing in this callback.
      isLoadingProject.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!project) return
    // Never save while the initial load is still in progress -- see
    // isLoadingProject's own doc comment; this effect re-runs several times
    // during loading, each with only some of the loaded state applied.
    if (isLoadingProject.current) return
    // Don't immediately re-save the project we just finished loading/creating.
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }

    if (saveTimer.current) clearTimeout(saveTimer.current)
    const performSave = (): Promise<void> => {
      saveTimer.current = null
      // `readyToUse`, not `stage === 'ready'` -- an item with a still-running
      // (or failed/canceled) background job is fully usable and must not be
      // dropped from the save just because thumbnail/waveform/proxy haven't
      // finished. `pendingStage` records what's left so reopening the
      // project can pick the background work back up (see MediaSource's own
      // doc comment and media.ts's rehydrate handler).
      const media: MediaSource[] = items
        .filter((m) => m.readyToUse)
        .map((m) => ({
          id: m.id,
          kind: m.kind,
          assetType: m.assetType,
          fileName: m.fileName,
          originalPath: m.originalPath,
          proxyPath: m.proxyPath,
          thumbnailPath: m.thumbnailPath,
          durationSeconds: m.metadata?.durationSeconds ?? 0,
          hasAudio: m.metadata?.hasAudio ?? false,
          addedAt: m.addedAt,
          pendingStage: pendingStageFor(m.stage)
        }))

      const snapshot: ProjectFile = {
        ...project,
        media,
        transcripts,
        scriptAlignments: Object.fromEntries(
          Object.entries(scriptAlignments).map(([mediaId, segments]) => [
            mediaId,
            {
              mediaId,
              scriptText: scriptTexts[mediaId] ?? '',
              segments,
              generatedAt: new Date().toISOString()
            }
          ])
        ),
        aiSuggestions: suggestionsByMedia,
        scenes: Object.values(scenesByMedia).flat(),
        sequence,
        brandPreset,
        narrativeGraph: narrativeGraphByMedia,
        entityBible: entityBibleByMedia,
        visualPlan: visualPlanByMedia,
        sceneGroups,
        theme: themeByMedia,
        narrationWorkspace: narrationState,
        dubbingWorkspace: withoutTransientDubbingState(dubbingState)
      }

      return window.api.project.save(snapshot).then((savedPath) => {
        setProject(snapshot)
        setProjectPath(savedPath)
        setLastSavedAt(new Date().toISOString())
      })
    }
    pendingSaveRef.current = performSave
    saveTimer.current = setTimeout(() => void performSave(), AUTOSAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,
    transcripts,
    scriptAlignments,
    scriptTexts,
    suggestionsByMedia,
    scenesByMedia,
    sequence,
    brandPreset,
    narrativeGraphByMedia,
    entityBibleByMedia,
    visualPlanByMedia,
    sceneGroups,
    themeByMedia,
    narrationState,
    dubbingState,
    project?.name,
    project?.coverPath
  ])

  const switchProject = useCallback(async (id: string | 'new') => {
    // The save that is waiting on the debounce runs NOW and is awaited:
    // it also records the current project as the one to reopen, so it
    // must land before the new choice is written, not after.
    if (saveTimer.current !== null && pendingSaveRef.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      try {
        await pendingSaveRef.current()
      } catch {
        // A failed flush must not strand the user on Home.
      }
    }
    if (id === 'new') await window.api.project.create('Untitled Project')
    else await window.api.project.open(id)
    markHomeSeen()
    window.location.reload()
  }, [])

  const setCover = useCallback((path: string) => {
    setProject((prev) => (prev && prev.coverPath !== path ? { ...prev, coverPath: path } : prev))
  }, [])

  const renameProject = useCallback((name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setProject((prev) => (prev && prev.name !== trimmed ? { ...prev, name: trimmed } : prev))
  }, [])

  const value = useMemo<ProjectContextValue>(
    () => ({
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      lastSavedAt,
      projectPath,
      createdAt: project?.createdAt ?? null,
      privacyMode: project?.privacyMode ?? null,
      renameProject,
      setCover,
      switchProject
    }),
    [project?.id, project?.name, project?.createdAt, project?.privacyMode, lastSavedAt, projectPath, renameProject, setCover, switchProject]
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject must be used within ProjectProvider')
  return ctx
}
