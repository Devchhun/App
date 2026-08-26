import { useMemo, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { listAllTemplates, searchTemplates, TEMPLATE_CATEGORY_LABELS } from './registry'
import type { TemplateDefinition } from './registry'
import { TemplateThumbnail } from './TemplateThumbnail'
import { buildTemplateSwitchPatch } from '../scenes/templateSwitch'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { PURPOSE_LABELS, PURPOSE_VALUES } from '@shared/suggestions'
import type { CommunicationPurpose } from '@shared/suggestions'
import type { TemplateCategory } from '@shared/templates'

const CATEGORY_OPTIONS: TemplateCategory[] = Object.keys(TEMPLATE_CATEGORY_LABELS) as TemplateCategory[]
/** Matches SceneContext.insertScene's own fixed default duration for a
 * freshly-added scene. */
const NEW_SCENE_DURATION_SECONDS = 3

export function TemplateBrowserPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { currentTime } = usePlayback()
  const { insertScene, updateScene, selectedSceneId, scenesByMedia } = useScenes()
  const { sequence, ensureTrack } = useSequence()
  const { brandPreset } = useBrandPreset()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all')
  const [purpose, setPurpose] = useState<CommunicationPurpose | 'all'>('all')

  const media = items.find((m) => m.id === selectedId)
  // Scenes are project-global -- look up the selected scene across every
  // bucket rather than assuming it belongs to whichever Media asset happens
  // to be selected in this panel (those are independent selections).
  const allScenes = useMemo(() => Object.values(scenesByMedia).flat(), [scenesByMedia])
  const selectedScene = selectedSceneId ? allScenes.find((s) => s.id === selectedSceneId) : undefined

  const filtered = useMemo(() => {
    let list = search.trim() ? searchTemplates(search) : listAllTemplates()
    if (category !== 'all') list = list.filter((t) => t.category === category)
    if (purpose !== 'all') list = list.filter((t) => t.supportedPurposes.includes(purpose))
    return list
  }, [search, category, purpose])

  // Explicit "Add as New" vs "Replace Selected" -- never guesses which the
  // user meant just from whether a scene happens to be selected. Add as New
  // always routes through findOrCreateTrack (picking a free graphic track,
  // or creating one) so several templates at the same playhead each get
  // their own track and stay simultaneously visible instead of overlapping.
  const handleAddNew = (definition: TemplateDefinition): void => {
    if (!media) return
    const occupied: OccupiedRange[] = allScenes.map((s) => ({ trackId: s.track, startTime: s.startTime, endTime: s.endTime }))
    const routing = findOrCreateTrack(sequence.tracks, occupied, currentTime, NEW_SCENE_DURATION_SECONDS, 'graphic')
    if (routing.newTrack) ensureTrack(routing.newTrack)
    insertScene(media.id, currentTime, routing.trackId, definition.id)
  }

  const handleReplaceSelected = (definition: TemplateDefinition): void => {
    if (!selectedScene || definition.id === selectedScene.templateId) return
    const patch = buildTemplateSwitchPatch(definition.id, selectedScene.presentationMode)
    updateScene(selectedScene.mediaId, selectedScene.id, patch)
  }

  return (
    <div className="template-library">
      <div className="panel-fixed-head">
        <input className="media-search-input" placeholder="Search templates…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="template-library-filter-row">
          <select value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory | 'all')}>
            <option value="all">All categories</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {TEMPLATE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value as CommunicationPurpose | 'all')}>
            <option value="all">All purposes</option>
            {PURPOSE_VALUES.map((p) => (
              <option key={p} value={p}>
                {PURPOSE_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        {!media && <p className="placeholder">Select a media item to add graphics to its timeline.</p>}
        {media && (
          <p className="placeholder">
            {selectedScene
              ? `A scene is selected -- "Add as New" inserts a fresh copy, "Replace Selected" swaps "${selectedScene.visualText.slice(0, 24)}"'s template in place.`
              : 'Click "Add as New" to add a template at the playhead. Multiple templates at the same time each get their own track.'}
          </p>
        )}
      </div>

      <div className="panel-scroll-body editor-scroll template-library-grid">
        {filtered.map((definition) => (
          <div key={definition.id} className="template-library-card" title={definition.description}>
            <TemplateThumbnail definition={definition} brand={brandPreset} />
            <span className="template-library-card-name">{definition.name}</span>
            <div className="template-library-card-actions">
              <button disabled={!media} onClick={() => handleAddNew(definition)}>
                Add as New
              </button>
              <button disabled={!selectedScene || definition.id === selectedScene?.templateId} onClick={() => handleReplaceSelected(definition)}>
                Replace Selected
              </button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <p className="placeholder">No templates match.</p>}
      </div>
    </div>
  )
}
