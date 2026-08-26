import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { useScenes } from '../scenes/SceneContext'
import { useStory } from './StoryContext'
import { CloudConsentModal } from '../suggestions/CloudConsentModal'
import { TEMPLATE_LABELS, TEMPLATE_ICON_IDS } from '@shared/templates'
import type { TemplateIconId } from '@shared/templates'
import { VISUALIZATION_TYPE_VALUES } from '@shared/story'
import type { CloudRequestPreview } from '@shared/suggestions'
import type { VisualizationType, StoryBeatImportance, NarrativeEntity, VisualPlanItem } from '@shared/story'
import { TemplateIcon } from '../templates/templateIcons'
import { storyBeatToScene } from './storyBeatToScene'
import { planStoryBeatPlacements } from './storyScenePlacement'
import { buildDefaultStoryTheme, mergeEntitiesIntoTheme } from './storyTheme'
import type { OccupiedRange } from '../timeline/trackModel'

const IMPORTANCE_VALUES: StoryBeatImportance[] = ['supporting', 'important', 'critical']

export function StoryVisualsPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { transcripts } = useTranscript()
  const { seekTo } = usePlayback()
  const { sequence, ensureTrack } = useSequence()
  const { scenesByMedia, insertScenes } = useScenes()
  const {
    narrativeGraphByMedia,
    entityBibleByMedia,
    visualPlanByMedia,
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
    addSceneGroup,
    setThemeForMedia,
    setThemeEntityColorForMedia
  } = useStory()

  const [pendingPreview, setPendingPreview] = useState<CloudRequestPreview | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeRequestId, setAnalyzeRequestId] = useState<string | null>(null)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [rejectedCount, setRejectedCount] = useState(0)
  const [editingBeatId, setEditingBeatId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editSummary, setEditSummary] = useState('')
  const [editVisualization, setEditVisualization] = useState<VisualizationType>('central-identity')
  const [editImportance, setEditImportance] = useState<StoryBeatImportance>('important')
  const [splitAtByBeat, setSplitAtByBeat] = useState<Record<string, number>>({})
  const [mergeTargetByEntity, setMergeTargetByEntity] = useState<Record<string, string>>({})

  const media = items.find((m) => m.id === selectedId)
  const transcript = media ? transcripts[media.id] : undefined
  const analysis = media ? narrativeGraphByMedia[media.id] : undefined
  const bible = media ? entityBibleByMedia[media.id] : undefined
  const plan = media ? visualPlanByMedia[media.id] : undefined
  const theme = media ? themeByMedia[media.id] : undefined

  const entitiesById = useMemo(() => new Map((bible?.entities ?? []).map((e) => [e.id, e])), [bible])
  const relationsById = useMemo(() => new Map((analysis?.graph.relations ?? []).map((r) => [r.id, r])), [analysis])
  const segmentTimesById = useMemo(() => {
    const map: Record<string, { startTime: number; endTime: number }> = {}
    for (const seg of transcript?.segments ?? []) map[seg.id] = { startTime: seg.startTime, endTime: seg.endTime }
    return map
  }, [transcript])

  const acceptedNotYetGenerated = useMemo(() => (plan?.items ?? []).filter((i) => i.status === 'accepted' && !i.generatedSceneId), [plan])

  if (!media) {
    return <div className="placeholder">Select a media item to plan connected story visuals.</div>
  }

  const handleAnalyzeClick = async (): Promise<void> => {
    if (!transcript || transcript.segments.length === 0) return
    const preview = await window.api.story.previewAnalysis(transcript.segments)
    setPendingPreview(preview)
  }

  const handleConfirmAnalyze = (): void => {
    if (!transcript || !media) return
    setPendingPreview(null)
    setAnalyzing(true)
    setAnalyzeError(null)
    const requestId = crypto.randomUUID()
    setAnalyzeRequestId(requestId)
    const durationSeconds = media.metadata?.durationSeconds ?? transcript.segments[transcript.segments.length - 1]?.endTime ?? 0
    void window.api.story.analyzeStory(requestId, media.id, transcript.segments, durationSeconds, 15).then((result) => {
      setAnalyzing(false)
      setAnalyzeRequestId(null)
      if (!result.ok) {
        setAnalyzeError(result.error.message)
        return
      }
      setNarrativeGraphForMedia(media.id, result.data.analysis)
      mergeEntitiesIntoBible(media.id, result.data.analysis.graph.entities)
      setRejectedCount(result.data.rejectedItems.length)
      const nextTheme = theme ? mergeEntitiesIntoTheme(theme, result.data.analysis.graph.entities) : buildDefaultStoryTheme(result.data.analysis.graph.entities)
      setThemeForMedia(media.id, nextTheme)
    })
  }

  const handleCancelAnalyze = (): void => {
    if (analyzeRequestId) void window.api.story.cancelAnalysis(analyzeRequestId)
  }

  const handleGenerateVisualPlan = (): void => {
    if (!analysis) return
    const planItems: VisualPlanItem[] = analysis.graph.beats.map((beat) => ({ beat, status: 'proposed', edited: false, locked: false }))
    setVisualPlanForMedia(media.id, { id: crypto.randomUUID(), mediaId: media.id, narrativeGraphId: analysis.id, items: planItems, createdAt: new Date().toISOString() })
  }

  const handleAcceptAll = (): void => {
    if (!plan) return
    for (const item of plan.items) setPlanItemStatus(media.id, item.beat.id, 'accepted')
  }

  const handleClearPlan = (): void => {
    if (!analysis) return
    setVisualPlanForMedia(media.id, { id: crypto.randomUUID(), mediaId: media.id, narrativeGraphId: analysis.id, items: [], createdAt: new Date().toISOString() })
  }

  const handleGenerateGraphics = (): void => {
    if (acceptedNotYetGenerated.length === 0 || !bible) return
    const resolvedTheme = theme ?? buildDefaultStoryTheme(bible.entities)
    const existingScenes = scenesByMedia[media.id] ?? []
    const occupied: OccupiedRange[] = [
      ...sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration })),
      ...existingScenes.map((s) => ({ trackId: s.track, startTime: s.startTime, endTime: s.endTime }))
    ]
    const beats = acceptedNotYetGenerated.map((i) => i.beat)
    const placements = planStoryBeatPlacements(beats, sequence.tracks, occupied)
    for (const p of placements) {
      if (p.newTrack) ensureTrack(p.newTrack)
    }
    const scenes = placements.map((p) => storyBeatToScene(p.beat, media.id, p.trackId, resolvedTheme, entitiesById, relationsById))
    insertScenes(media.id, scenes)
    if (analysis) {
      addSceneGroup({
        id: crypto.randomUUID(),
        name: `${media.fileName} — Story Visuals`,
        narrativeGraphId: analysis.id,
        sceneIds: scenes.map((s) => s.id),
        theme: resolvedTheme,
        entityBibleId: bible.id,
        lockedContinuity: false
      })
    }
    placements.forEach((p, i) => markPlanItemGenerated(media.id, p.beat.id, scenes[i].id))
  }

  const startEdit = (item: VisualPlanItem): void => {
    setEditingBeatId(item.beat.id)
    setEditTitle(item.beat.title)
    setEditSummary(item.beat.summary)
    setEditVisualization(item.beat.recommendedVisualization)
    setEditImportance(item.beat.importance)
  }

  const saveEdit = (beatId: string): void => {
    editPlanItemBeat(media.id, beatId, { title: editTitle, summary: editSummary, recommendedVisualization: editVisualization, importance: editImportance })
    setEditingBeatId(null)
  }

  const entityNames = (ids: string[]): string => ids.map((id) => entitiesById.get(id)?.canonicalName ?? id).join(', ')

  return (
    <div className="story-visuals-panel">
      <div className="panel-fixed-head">
        {!transcript && <p className="placeholder">Transcribe this media first (Transcript panel).</p>}

        <div className="story-toolbar">
          {!analyzing && (
            <button onClick={() => void handleAnalyzeClick()} disabled={!transcript}>
              Analyze Full Story
            </button>
          )}
          {analyzing && (
            <button className="ai-cancel-button" onClick={handleCancelAnalyze}>
              Cancel Analysis
            </button>
          )}
          {analysis && !analyzing && (
            <button className="inline-link-button" onClick={handleGenerateVisualPlan}>
              Generate Visual Plan
            </button>
          )}
          {plan && plan.items.length > 0 && (
            <>
              <button className="inline-link-button" onClick={handleAcceptAll}>
                Accept All
              </button>
              <button onClick={handleGenerateGraphics} disabled={acceptedNotYetGenerated.length === 0}>
                Generate Accepted Graphics ({acceptedNotYetGenerated.length}, 1 Undo step)
              </button>
              <button className="inline-link-button" onClick={handleClearPlan}>
                Clear Plan
              </button>
            </>
          )}
        </div>

        {analyzing && <div className="transcript-status-banner">Analyzing the full transcript…</div>}
        {analyzeError && (
          <div className="transcript-error-banner">
            {analyzeError}
            <button className="inline-link-button" onClick={() => void handleAnalyzeClick()}>
              Retry
            </button>
          </div>
        )}
        {rejectedCount > 0 && (
          <div className="transcript-status-banner">{rejectedCount} item(s) from the last analysis failed validation and were dropped.</div>
        )}

        {analysis && (
          <div className="story-analysis-summary">
            <div>
              <strong>Central question:</strong> <span lang="km">{analysis.graph.centralQuestion}</span>
            </div>
            <div>
              <strong>Conclusion:</strong> <span lang="km">{analysis.graph.finalConclusion}</span>
            </div>
            <div>
              {analysis.graph.entities.length} entities · {analysis.graph.relations.length} relations · {analysis.graph.beats.length} beats
            </div>
          </div>
        )}

        {bible && bible.entities.length > 0 && (
          <details className="story-entity-bible">
            <summary>Entity Bible ({bible.entities.length})</summary>
            {bible.entities.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity}
                locked={bible.lockedEntityIds.includes(entity.id)}
                allEntities={bible.entities}
                mergeTarget={mergeTargetByEntity[entity.id] ?? ''}
                onSetMergeTarget={(target) => setMergeTargetByEntity((prev) => ({ ...prev, [entity.id]: target }))}
                onUpdate={(patch) => updateEntity(media.id, entity.id, patch)}
                onToggleLock={() => setEntityLocked(media.id, entity.id, !bible.lockedEntityIds.includes(entity.id))}
                onMerge={() => {
                  const target = mergeTargetByEntity[entity.id]
                  if (target) mergeEntities(media.id, target, entity.id)
                }}
              />
            ))}
          </details>
        )}

        {theme && bible && bible.entities.length > 0 && (
          <details className="story-continuity">
            <summary>Continuity (shared theme)</summary>
            {bible.entities.map((entity) => (
              <label key={entity.id} className="story-theme-swatch-row">
                <input
                  type="color"
                  value={theme.entityColors[entity.id] ?? entity.color}
                  onChange={(e) => setThemeEntityColorForMedia(media.id, entity.id, e.target.value)}
                />
                <span lang="km">{entity.canonicalName}</span>
              </label>
            ))}
          </details>
        )}
      </div>

      <ul className="story-visual-plan-list panel-scroll-body editor-scroll">
        {plan?.items.map((item, index) => {
          const isEditing = editingBeatId === item.beat.id
          return (
            <li key={item.beat.id} className={`ai-suggestion-card ai-suggestion-${item.status}${item.locked ? ' ai-suggestion-locked' : ''}`}>
              <div className="ai-suggestion-header">
                <span className="ai-suggestion-purpose">{TEMPLATE_LABELS[item.beat.recommendedVisualization]}</span>
                <span className="ai-suggestion-confidence">{item.beat.importance}</span>
              </div>
              <button className="ai-suggestion-time" onClick={() => seekTo(item.beat.startTime)}>
                {item.beat.startTime.toFixed(1)}s – {item.beat.endTime.toFixed(1)}s
              </button>

              {!isEditing && (
                <>
                  <div className="ai-suggestion-visual-text" lang="km">
                    {item.beat.title}
                  </div>
                  <div className="ai-suggestion-reason" lang="km">
                    {item.beat.summary}
                  </div>
                  {item.beat.entities.length > 0 && <div className="story-beat-entities">Entities: {entityNames(item.beat.entities)}</div>}
                  {item.beat.evidence && item.beat.evidence.length > 0 && <div className="story-beat-entities">Evidence: {item.beat.evidence.join('; ')}</div>}
                  {item.generatedSceneId && <span className="ai-suggestion-status-label">Generated</span>}
                  {item.edited && <span className="ai-suggestion-edited-badge">Edited</span>}
                </>
              )}
              {isEditing && (
                <div className="local-ai-edit-form">
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Beat title" lang="km" />
                  <textarea value={editSummary} onChange={(e) => setEditSummary(e.target.value)} placeholder="Summary" lang="km" rows={2} />
                  <select value={editVisualization} onChange={(e) => setEditVisualization(e.target.value as VisualizationType)}>
                    {VISUALIZATION_TYPE_VALUES.map((v) => (
                      <option key={v} value={v}>
                        {TEMPLATE_LABELS[v]}
                      </option>
                    ))}
                  </select>
                  <select value={editImportance} onChange={(e) => setEditImportance(e.target.value as StoryBeatImportance)}>
                    {IMPORTANCE_VALUES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="ai-suggestion-actions">
                {isEditing ? (
                  <>
                    <button onClick={() => saveEdit(item.beat.id)}>Save</button>
                    <button className="inline-link-button" onClick={() => setEditingBeatId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {item.status !== 'accepted' && (
                      <button onClick={() => setPlanItemStatus(media.id, item.beat.id, 'accepted')}>Accept</button>
                    )}
                    {item.status !== 'rejected' && (
                      <button onClick={() => setPlanItemStatus(media.id, item.beat.id, 'rejected')}>Reject</button>
                    )}
                    <button className="inline-link-button" onClick={() => startEdit(item)}>
                      Edit
                    </button>
                    <button className="inline-link-button" onClick={() => toggleplanItemLock(media.id, item.beat.id)}>
                      {item.locked ? 'Unlock' : 'Lock'}
                    </button>
                    {index > 0 && !item.locked && (
                      <button className="inline-link-button" onClick={() => mergePlanItemWithPrevious(media.id, index)}>
                        Merge with previous
                      </button>
                    )}
                    {!item.locked && (
                      <span className="story-split-control">
                        <input
                          type="number"
                          step={0.5}
                          min={item.beat.startTime}
                          max={item.beat.endTime}
                          value={splitAtByBeat[item.beat.id] ?? (item.beat.startTime + item.beat.endTime) / 2}
                          onChange={(e) => setSplitAtByBeat((prev) => ({ ...prev, [item.beat.id]: Number(e.target.value) }))}
                        />
                        <button
                          className="inline-link-button"
                          onClick={() => splitPlanItem(media.id, index, splitAtByBeat[item.beat.id] ?? (item.beat.startTime + item.beat.endTime) / 2, segmentTimesById)}
                        >
                          Split
                        </button>
                      </span>
                    )}
                    <button className="inline-link-button" onClick={() => removePlanItem(media.id, item.beat.id)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          )
        })}
        {(!plan || plan.items.length === 0) && !analyzing && (
          <li className="placeholder">
            {analysis ? 'No Visual Plan yet. Click "Generate Visual Plan" above.' : 'No story analysis yet. Click "Analyze Full Story" above.'}
          </li>
        )}
      </ul>

      {pendingPreview && (
        <CloudConsentModal preview={pendingPreview} onCancel={() => setPendingPreview(null)} onConfirm={handleConfirmAnalyze} />
      )}
    </div>
  )
}

function EntityRow({
  entity,
  locked,
  allEntities,
  mergeTarget,
  onSetMergeTarget,
  onUpdate,
  onToggleLock,
  onMerge
}: {
  entity: NarrativeEntity
  locked: boolean
  allEntities: NarrativeEntity[]
  mergeTarget: string
  onSetMergeTarget: (id: string) => void
  onUpdate: (patch: Partial<NarrativeEntity>) => void
  onToggleLock: () => void
  onMerge: () => void
}): JSX.Element {
  return (
    <div className="story-entity-row">
      <span className="story-entity-icon">
        <TemplateIcon id={entity.iconId ?? 'person'} size={16} color={entity.color} />
      </span>
      <input
        className="story-entity-name-input"
        value={entity.canonicalName}
        disabled={locked}
        lang="km"
        onChange={(e) => onUpdate({ canonicalName: e.target.value })}
      />
      <input type="color" value={entity.color} disabled={locked} onChange={(e) => onUpdate({ color: e.target.value })} />
      <select value={entity.iconId ?? ''} disabled={locked} onChange={(e) => onUpdate({ iconId: (e.target.value || undefined) as TemplateIconId | undefined })}>
        <option value="">No icon</option>
        {TEMPLATE_ICON_IDS.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <button className="inline-link-button" onClick={onToggleLock}>
        {locked ? 'Unlock' : 'Lock'}
      </button>
      <select value={mergeTarget} onChange={(e) => onSetMergeTarget(e.target.value)}>
        <option value="">Merge into…</option>
        {allEntities
          .filter((e) => e.id !== entity.id)
          .map((e) => (
            <option key={e.id} value={e.id}>
              {e.canonicalName}
            </option>
          ))}
      </select>
      <button className="inline-link-button" disabled={!mergeTarget} onClick={onMerge}>
        Merge
      </button>
    </div>
  )
}
