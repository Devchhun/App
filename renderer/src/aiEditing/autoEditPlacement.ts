import type { ProjectSequence, TimelineClip } from '@shared/project'
import type { TimelineTrack } from '@shared/timelineTracks'
import { DEFAULT_AUDIO_TRACK_HEIGHT, DEFAULT_VIDEO_TRACK_HEIGHT } from '@shared/timelineTracks'
import type { AutoEditPlan } from '@shared/autoEdit'

export interface AutoEditMedia {
  mediaId: string
  durationSeconds: number
}

type IdFactory = () => string
const uuid: IdFactory = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`)

/**
 * Turn an auto-edit plan into a new sequence: the chosen scenes as video clips
 * on a fresh "AI Edit" track, and the narration as one audio clip on its own
 * track. Appended, never overwriting the user's existing tracks/clips, so the
 * result drops in beside whatever is already there and stays fully editable
 * with the normal tools. Pure (given the id factory).
 */
export function buildAutoEditSequence(
  sequence: ProjectSequence,
  plan: AutoEditPlan,
  source: AutoEditMedia,
  narration: AutoEditMedia | undefined,
  makeId: IdFactory = uuid,
): ProjectSequence {
  const maxOrder = sequence.tracks.reduce((m, t) => Math.max(m, t.order), -1)
  const videoTrackId = `ai-edit-v-${makeId()}`
  const audioTrackId = `ai-edit-a-${makeId()}`

  const videoTrack: TimelineTrack = {
    id: videoTrackId, kind: 'video', name: 'AI Edit', order: maxOrder + 1,
    height: DEFAULT_VIDEO_TRACK_HEIGHT, hidden: false, locked: false, removable: true,
  }
  const videoClips: TimelineClip[] = plan.clips.map((c) => ({
    id: makeId(),
    mediaId: source.mediaId,
    type: 'video',
    trackId: videoTrackId,
    startTime: c.timelineStart,
    duration: c.duration,
    sourceIn: c.sourceIn,
    // Never past the real media length (a scene detected near the end could
    // otherwise ask for a source-out a hair beyond it).
    sourceOut: Math.min(c.sourceOut, source.durationSeconds || c.sourceOut),
    locked: false,
  }))

  const tracks = [...sequence.tracks, videoTrack]
  const clips = [...sequence.clips, ...videoClips]

  if (narration && narration.durationSeconds > 0) {
    tracks.push({
      id: audioTrackId, kind: 'audio', name: 'AI Narration', order: maxOrder + 2,
      height: DEFAULT_AUDIO_TRACK_HEIGHT, hidden: false, locked: false, muted: false, removable: true,
    })
    clips.push({
      id: makeId(),
      mediaId: narration.mediaId,
      type: 'audio',
      trackId: audioTrackId,
      startTime: 0,
      duration: narration.durationSeconds,
      sourceIn: 0,
      sourceOut: narration.durationSeconds,
      locked: false,
    })
  }

  const duration = Math.max(sequence.duration, plan.duration, narration?.durationSeconds ?? 0)
  return { ...sequence, tracks, clips, duration }
}
