import { useState } from 'react'
import { useProject } from './ProjectContext'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useChangeAspectRatio } from '../scenes/useAspectRatioChange'
import { computeSequenceDuration, type BrandPreset } from '@shared/project'
import { formatDuration } from '../media/format'

const ASPECT_RATIOS: BrandPreset['defaultAspectRatio'][] = ['16:9', '9:16', '1:1']

/** The export frame each aspect ratio renders at (1080p class). */
const RESOLUTION_FOR_ASPECT: Record<BrandPreset['defaultAspectRatio'], string> = {
  '16:9': '1920 × 1080',
  '9:16': '1080 × 1920',
  '1:1': '1080 × 1080'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

/** What the Properties tab shows when nothing on the Timeline is selected:
 * the project's own details (CapCut-style "Details" sheet) rather than a
 * "select something" placeholder. Read-only rows, with Modify at the
 * bottom switching Name and Aspect ratio -- the two things that are the
 * project's to change here -- into inline fields. */
export function ProjectDetailsPanel(): JSX.Element {
  const { projectName, projectPath, createdAt, lastSavedAt, privacyMode, renameProject } = useProject()
  const { items } = useMedia()
  const { sequence } = useSequence()
  const { brandPreset } = useBrandPreset()
  const changeAspectRatio = useChangeAspectRatio()
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftAspect, setDraftAspect] = useState<BrandPreset['defaultAspectRatio']>('16:9')

  const aspect = brandPreset.defaultAspectRatio
  const duration = computeSequenceDuration(sequence.clips)
  const videoCount = items.filter((m) => m.kind === 'video').length
  const audioCount = items.filter((m) => m.kind === 'audio').length
  const imageCount = items.length - videoCount - audioCount
  // The project's frame rate follows whatever sits on the main video track
  // first; with nothing there yet it's the app's own 30fps default.
  const mainTrackId = sequence.tracks.find((t) => t.isMain)?.id
  const mainClip = [...sequence.clips].filter((c) => c.trackId === mainTrackId).sort((a, b) => a.startTime - b.startTime)[0]
  const frameRate = items.find((m) => m.id === mainClip?.mediaId)?.metadata?.frameRate ?? 30

  const beginEdit = (): void => {
    setDraftName(projectName ?? '')
    setDraftAspect(aspect)
    setEditing(true)
  }
  const commitEdit = (): void => {
    renameProject(draftName)
    changeAspectRatio(draftAspect)
    setEditing(false)
  }

  return (
    <div className="scene-properties project-details">
      <div className="panel-fixed-head">
        <div className="scene-properties-header">
          <h3>Details</h3>
        </div>
      </div>
      <div className="panel-scroll-body editor-scroll project-details-body">
        <dl className="project-details-list">
          <dt>Name:</dt>
          <dd>
            {editing ? (
              <input
                className="project-details-input"
                type="text"
                value={draftName}
                autoFocus
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit()
                  if (e.key === 'Escape') setEditing(false)
                }}
              />
            ) : (
              projectName ?? '—'
            )}
          </dd>
          <dt>Path:</dt>
          <dd className="project-details-path" title={projectPath ?? undefined}>
            {projectPath ?? 'Not saved yet'}
          </dd>
          <dt>Aspect ratio:</dt>
          <dd>
            {editing ? (
              <select className="project-details-input" value={draftAspect} onChange={(e) => setDraftAspect(e.target.value as BrandPreset['defaultAspectRatio'])}>
                {ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              aspect
            )}
          </dd>
          <dt>Resolution:</dt>
          <dd>{RESOLUTION_FOR_ASPECT[editing ? draftAspect : aspect]}</dd>
          <dt>Frame rate:</dt>
          <dd>{frameRate.toFixed(2)}fps</dd>
          <dt>Duration:</dt>
          <dd>{duration > 0 ? formatDuration(duration) : '—'}</dd>
          <dt>Imported media:</dt>
          <dd>
            {items.length === 0
              ? 'None'
              : [videoCount && `${videoCount} video`, audioCount && `${audioCount} audio`, imageCount && `${imageCount} image`].filter(Boolean).join(' · ')}
            <span className="project-details-note">Stay in original location</span>
          </dd>
          <dt>Tracks:</dt>
          <dd>
            {sequence.tracks.length} · {sequence.clips.length} {sequence.clips.length === 1 ? 'clip' : 'clips'}
          </dd>
        </dl>

        <div className="project-details-divider" />

        <dl className="project-details-list">
          <dt>Privacy:</dt>
          <dd>{privacyMode === 'cloud-assisted' ? 'Cloud-assisted' : 'Fully local'}</dd>
          <dt>Created:</dt>
          <dd>{formatDate(createdAt)}</dd>
          <dt>Last saved:</dt>
          <dd>{lastSavedAt ? formatDate(lastSavedAt) : 'Not saved this session'}</dd>
        </dl>
      </div>
      <div className="project-details-foot">
        {editing ? (
          <>
            <button className="project-details-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="project-details-button project-details-button-primary" onClick={commitEdit}>
              Save
            </button>
          </>
        ) : (
          <button className="project-details-button" onClick={beginEdit}>
            Modify
          </button>
        )}
      </div>
    </div>
  )
}
