import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useSequence } from '../sequence/SequenceContext'
import { useScenes } from '../scenes/SceneContext'
import { useLocalAi } from './LocalAiContext'
import { PURPOSE_LABELS } from '@shared/suggestions'
import { TEMPLATE_LABELS, TEMPLATE_CATEGORY_LABELS } from '@shared/templates'
import type { TemplateCategory, TemplateId } from '@shared/templates'
import { SCENE_DENSITY_VALUES } from '@shared/localAi'
import type { ScenePlanScene } from '@shared/localAi'
import { listAllTemplates } from '../templates/registry'
import { planScenePlacements } from '../scenes/scenePlacementPlanning'
import { scenePlanSceneToScene } from '../scenes/scenePlanToScenes'
import type { OccupiedRange } from '../timeline/trackModel'

/** A short list of models known to work well for this task (structured JSON
 * output + reasonable multilingual/Khmer coverage) -- shown as one-click
 * suggestions; the user can still type/pull any other Ollama model id. */
const SUGGESTED_MODELS = ['qwen2.5:7b-instruct', 'qwen2.5:3b-instruct', 'llama3.1:8b']

const CATEGORY_OPTIONS = Object.keys(TEMPLATE_CATEGORY_LABELS) as TemplateCategory[]
const ALL_TEMPLATES = listAllTemplates()

/** Deterministic (non-AI) count of accepted scenes that time-overlap at
 * least one other accepted scene -- these are exactly the ones
 * planScenePlacements must route onto a separate track. Pure/pairwise, fine
 * at the scene counts this feature ever deals with (<=40). */
function countConflicting(scenes: ScenePlanScene[]): number {
  const conflicted = new Set<string>()
  for (let i = 0; i < scenes.length; i++) {
    for (let j = i + 1; j < scenes.length; j++) {
      if (scenes[i].startTime < scenes[j].endTime && scenes[j].startTime < scenes[i].endTime) {
        conflicted.add(scenes[i].id)
        conflicted.add(scenes[j].id)
      }
    }
  }
  return conflicted.size
}

export function LocalAiPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { transcripts } = useTranscript()
  const { seekTo } = usePlayback()
  const { sequence, ensureTrack } = useSequence()
  const { scenesByMedia, insertScenes } = useScenes()
  const {
    health,
    refreshHealth,
    models,
    selectedModel,
    setSelectedModel,
    options,
    setOptions,
    pulls,
    startPull,
    cancelPull,
    retryPull,
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
  } = useLocalAi()

  const [pullModelInput, setPullModelInput] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editTemplateId, setEditTemplateId] = useState<TemplateId | null>(null)

  const media = items.find((m) => m.id === selectedId)
  const transcript = media ? transcripts[media.id] : undefined
  const isGenerating = generationState === 'generating'
  const activePull = Object.values(pulls).find((p) => p.status === 'pulling' || p.status === 'verifying')

  const isMediaMismatch = media && currentMediaId && currentMediaId !== media.id

  const acceptedScenes = useMemo(() => previewItems.filter((i) => i.status === 'accepted').map((i) => i.scene), [previewItems])
  const acceptedCount = acceptedScenes.length

  // Deterministic preview summary + the exact placements Apply will use --
  // computed once here and reused by handleApply, so the summary shown to
  // the user can never drift from what actually happens on Apply.
  const existingScenes = media ? scenesByMedia[media.id] ?? [] : []
  const occupied: OccupiedRange[] = useMemo(
    () => [
      ...sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration })),
      ...existingScenes.map((s) => ({ trackId: s.track, startTime: s.startTime, endTime: s.endTime }))
    ],
    [sequence.clips, existingScenes]
  )
  const placements = useMemo(() => planScenePlacements(acceptedScenes, sequence.tracks, occupied), [acceptedScenes, sequence.tracks, occupied])
  const newTrackCount = useMemo(() => new Set(placements.filter((p) => p.newTrack).map((p) => p.trackId)).size, [placements])
  const usedTrackIds = useMemo(() => Array.from(new Set(placements.map((p) => p.trackId))).sort(), [placements])
  const conflictCount = useMemo(() => countConflicting(acceptedScenes), [acceptedScenes])
  const lockedExistingCount = existingScenes.filter((s) => s.locked).length

  if (!media) {
    return <div className="placeholder">Select a media item to plan AI scenes.</div>
  }

  const handleGenerate = (): void => {
    if (!transcript || transcript.segments.length === 0) return
    void generate(media.id, transcript.segments, media.metadata?.durationSeconds ?? transcript.segments[transcript.segments.length - 1]?.endTime ?? 0)
  }

  const handleApply = (): void => {
    if (acceptedScenes.length === 0) return
    for (const p of placements) {
      if (p.newTrack) ensureTrack(p.newTrack)
    }
    const scenes = placements.map((p) => {
      const seg = transcript?.segments.find((s) => s.id === p.scene.segmentId)
      return scenePlanSceneToScene(p.scene, media.id, p.trackId, seg?.editedText ?? seg?.text ?? '')
    })
    insertScenes(media.id, scenes)
    clearPreview()
  }

  const startEdit = (s: ScenePlanScene): void => {
    setEditingId(s.id)
    setEditTitle(s.content.title ?? s.content.value ?? s.content.eyebrow ?? '')
    setEditTemplateId(s.templateId)
  }

  const saveEdit = (s: ScenePlanScene): void => {
    editScene(s.id, { content: { ...s.content, title: editTitle }, templateId: editTemplateId ?? s.templateId })
    setEditingId(null)
  }

  const toggleCategory = (c: TemplateCategory): void => {
    const has = options.preferredCategories.includes(c)
    setOptions({ preferredCategories: has ? options.preferredCategories.filter((x) => x !== c) : [...options.preferredCategories, c] })
  }

  return (
    <div className="local-ai-panel">
      <div className="panel-fixed-head">
        <div className="local-ai-health-row">
          <span className={`local-ai-health-dot local-ai-health-${health?.status ?? 'unknown'}`} />
          <span className="local-ai-health-label">
            {health?.status === 'running' && `Ollama running${health.version ? ` (v${health.version})` : ''}`}
            {health?.status === 'installed-not-running' && 'Ollama installed but not running'}
            {health?.status === 'not-installed' && 'Ollama not installed'}
            {(!health || health.status === 'unknown') && 'Checking local AI status…'}
          </span>
          <button className="inline-link-button" onClick={() => void refreshHealth()}>
            Refresh
          </button>
        </div>

        {health?.status !== 'running' && (
          <p className="placeholder">
            This feature runs entirely on your machine via{' '}
            <span style={{ userSelect: 'text' }}>Ollama</span> -- no transcript or generated content ever leaves this
            computer. Install Ollama and start it, then refresh above.
          </p>
        )}

        {health?.status === 'running' && (
          <>
            <div className="local-ai-model-row">
              <select value={selectedModel ?? ''} onChange={(e) => setSelectedModel(e.target.value)}>
                <option value="" disabled>
                  Select a model…
                </option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.loaded ? ' (loaded)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {models.length === 0 && (
              <div className="local-ai-suggested-models">
                <span>No models installed. Suggested:</span>
                {SUGGESTED_MODELS.map((m) => (
                  <button key={m} className="inline-link-button" onClick={() => startPull(m)}>
                    Download {m}
                  </button>
                ))}
              </div>
            )}

            <div className="local-ai-pull-row">
              <input
                className="local-ai-pull-input"
                placeholder="model name, e.g. qwen2.5:7b-instruct"
                value={pullModelInput}
                onChange={(e) => setPullModelInput(e.target.value)}
              />
              <button disabled={!pullModelInput.trim()} onClick={() => startPull(pullModelInput.trim())}>
                Download
              </button>
            </div>

            {Object.values(pulls).map((p) => (
              <div key={p.requestId} className="local-ai-pull-progress">
                <span>
                  {p.model}: {p.status} {p.percent}%
                </span>
                <progress value={p.percent} max={100} />
                {(p.status === 'pulling' || p.status === 'verifying') && <button onClick={() => cancelPull(p.requestId)}>Cancel</button>}
                {(p.status === 'error' || p.status === 'canceled') && (
                  <button onClick={() => retryPull(p.requestId, p.model)}>
                    Retry{p.status === 'error' ? ` (${p.message ?? 'error'})` : ''}
                  </button>
                )}
              </div>
            ))}

            <details className="local-ai-quality-controls">
              <summary>Quality controls</summary>
              <div className="local-ai-quality-row">
                <label>
                  Creativity ({options.creativity}%)
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={options.creativity}
                    onChange={(e) => setOptions({ creativity: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="local-ai-quality-row">
                <label>
                  Scene density
                  <select value={options.density} onChange={(e) => setOptions({ density: e.target.value as typeof options.density })}>
                    {SCENE_DENSITY_VALUES.map((d) => (
                      <option key={d} value={d}>
                        {d[0].toUpperCase() + d.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="local-ai-quality-row">
                <label>
                  Max simultaneous graphics
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={options.maxSimultaneousGraphics}
                    onChange={(e) => setOptions({ maxSimultaneousGraphics: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                  />
                </label>
              </div>
              <div className="local-ai-quality-row">
                <label>
                  Minimum confidence ({Math.round(options.minConfidence * 100)}%)
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(options.minConfidence * 100)}
                    onChange={(e) => setOptions({ minConfidence: Number(e.target.value) / 100 })}
                  />
                </label>
              </div>
              <div className="local-ai-quality-row local-ai-category-picker">
                <span>Preferred template categories (optional)</span>
                <div className="local-ai-category-checkboxes">
                  {CATEGORY_OPTIONS.map((c) => (
                    <label key={c} className="local-ai-category-checkbox">
                      <input type="checkbox" checked={options.preferredCategories.includes(c)} onChange={() => toggleCategory(c)} />
                      {TEMPLATE_CATEGORY_LABELS[c]}
                    </label>
                  ))}
                </div>
              </div>
            </details>
          </>
        )}

        {!transcript && <p className="placeholder">Transcribe this media first (Transcript panel).</p>}

        <div className="local-ai-toolbar">
          {!isGenerating && (
            <button onClick={handleGenerate} disabled={!transcript || !selectedModel || health?.status !== 'running' || !!activePull}>
              Generate Scene Plan
            </button>
          )}
          {isGenerating && (
            <button className="ai-cancel-button" onClick={cancelGenerate}>
              Cancel
            </button>
          )}
          {previewItems.length > 0 && !isGenerating && (
            <>
              <button className="inline-link-button" onClick={() => setAllScenesStatus('accepted')}>
                Accept all
              </button>
              <button className="inline-link-button" onClick={() => setAllScenesStatus('rejected')}>
                Reject all
              </button>
              <button onClick={handleApply} disabled={acceptedCount === 0 || !!isMediaMismatch}>
                Apply Selected ({acceptedCount} scene{acceptedCount === 1 ? '' : 's'}, 1 Undo step)
              </button>
              <button className="inline-link-button" onClick={clearPreview}>
                Discard preview
              </button>
            </>
          )}
        </div>

        {isGenerating && <div className="transcript-status-banner">Analyzing transcript locally…</div>}
        {generationState === 'canceled' && <div className="transcript-status-banner">Canceled.</div>}
        {generationState === 'error' && generationError && (
          <div className="transcript-error-banner">
            {generationError.message}
            <button className="inline-link-button" onClick={handleGenerate}>
              Retry
            </button>
          </div>
        )}
        {isMediaMismatch && <div className="transcript-error-banner">This plan was generated for a different media item.</div>}
        {rejectedScenes.length > 0 && (
          <div className="transcript-status-banner">
            {rejectedScenes.length} proposed scene{rejectedScenes.length === 1 ? '' : 's'} failed validation and were dropped: {rejectedScenes[0].reason}
            {rejectedScenes.length > 1 ? ` (+${rejectedScenes.length - 1} more)` : ''}
          </div>
        )}

      </div>

      <ul className="ai-suggestions-list panel-scroll-body editor-scroll">
        {previewItems.length > 0 && !isGenerating && (
          <li className="local-ai-preview-summary">
            <div className="local-ai-preview-summary-title">Apply preview (deterministic)</div>
            <ul>
              <li>Proposed scenes: {previewItems.length} · Selected to apply: {acceptedCount}</li>
              <li>Transcript source: {media.fileName} ({transcript?.segments.length ?? 0} segments)</li>
              <li>
                Track placement: {usedTrackIds.length === 0 ? 'none yet (select scenes to apply)' : usedTrackIds.join(', ')}
                {newTrackCount > 0 ? ` (${newTrackCount} new track${newTrackCount === 1 ? '' : 's'} will be created)` : ''}
              </li>
              <li>Overlapping/conflicting scenes needing separate tracks: {conflictCount}</li>
              <li>
                Existing scenes on this media preserved untouched: {existingScenes.length}
                {lockedExistingCount > 0 ? ` (${lockedExistingCount} locked)` : ''}
              </li>
            </ul>
          </li>
        )}
        {previewItems.map((item) => {
          const s = item.scene
          const isEditing = editingId === s.id
          return (
            <li key={s.id} className={`ai-suggestion-card ai-suggestion-${item.status === 'pending' ? 'suggested' : item.status}`}>
              <div className="ai-suggestion-header">
                <span className="ai-suggestion-purpose">{PURPOSE_LABELS[s.purpose]}</span>
                <span className="ai-suggestion-confidence">{Math.round(s.confidence * 100)}%</span>
              </div>
              <button className="ai-suggestion-time" onClick={() => seekTo(s.startTime)}>
                {s.startTime.toFixed(1)}s – {s.endTime.toFixed(1)}s · {TEMPLATE_LABELS[s.templateId]}
              </button>

              {!isEditing && <div className="ai-suggestion-visual-text">{s.content.title ?? s.content.value ?? s.content.eyebrow ?? '(no title)'}</div>}
              {isEditing && (
                <div className="local-ai-edit-form">
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="On-screen text" />
                  <select value={editTemplateId ?? s.templateId} onChange={(e) => setEditTemplateId(e.target.value as TemplateId)}>
                    {ALL_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="ai-suggestion-reason">{s.explanation}</div>

              <div className="ai-suggestion-actions">
                {isEditing ? (
                  <>
                    <button onClick={() => saveEdit(s)}>Save</button>
                    <button className="inline-link-button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {item.status === 'pending' && (
                      <>
                        <button onClick={() => setSceneStatus(s.id, 'accepted')}>Accept</button>
                        <button onClick={() => setSceneStatus(s.id, 'rejected')}>Reject</button>
                        <button className="inline-link-button" onClick={() => startEdit(s)}>
                          Edit
                        </button>
                      </>
                    )}
                    {item.status !== 'pending' && (
                      <>
                        <span className="ai-suggestion-status-label">{item.status === 'accepted' ? 'Accepted' : 'Rejected'}</span>
                        <button className="inline-link-button" onClick={() => setSceneStatus(s.id, 'pending')}>
                          Undo
                        </button>
                        <button className="inline-link-button" onClick={() => startEdit(s)}>
                          Edit
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
        {previewItems.length === 0 && !isGenerating && (
          <li className="placeholder">No scene plan yet. Click "Generate Scene Plan" above.</li>
        )}
      </ul>
    </div>
  )
}
