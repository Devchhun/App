import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useAiSuggestions } from '../suggestions/AiSuggestionsContext'
import { useScenes } from '../scenes/SceneContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { useStory } from '../story/StoryContext'
import type { ProjectFile, MediaSource, Scene } from '@shared/project'

interface ProjectContextValue {
  projectId: string | null
  projectName: string | null
  lastSavedAt: string | null
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

const AUTOSAVE_DEBOUNCE_MS = 3000

export function ProjectProvider({ children }: { children: ReactNode }): JSX.Element {
  const { items, hydrateFromSaved } = useMedia()
  const { transcripts, scriptAlignments, scriptTexts, hydrateFromSaved: hydrateTranscriptsFromSaved } = useTranscript()
  const { suggestionsByMedia, setSuggestionsForMedia } = useAiSuggestions()
  const { scenesByMedia, setScenesForMedia } = useScenes()
  const { brandPreset, setBrandPreset } = useBrandPreset()
  const { sequence, restoreSequence } = useSequence()
  const { suppressNextRecord } = useHistory()
  const { narrativeGraphByMedia, entityBibleByMedia, visualPlanByMedia, sceneGroups, themeByMedia, restoreStoryState } = useStory()
  const [project, setProject] = useState<ProjectFile | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRun = useRef(true)

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
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!project) return
    // Don't immediately re-save the project we just loaded/created.
    if (isFirstRun.current) {
      isFirstRun.current = false
      return
    }

    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const media: MediaSource[] = items
        .filter((m) => m.stage === 'ready')
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
          addedAt: m.addedAt
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
        theme: themeByMedia
      }

      void window.api.project.save(snapshot).then(() => {
        setProject(snapshot)
        setLastSavedAt(new Date().toISOString())
      })
    }, AUTOSAVE_DEBOUNCE_MS)

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
    themeByMedia
  ])

  return (
    <ProjectContext.Provider value={{ projectId: project?.id ?? null, projectName: project?.name ?? null, lastSavedAt }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject must be used within ProjectProvider')
  return ctx
}
