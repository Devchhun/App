// The dynamic Timeline track registry -- replaces the old fixed
// TimelineTrackId ('V1'|'A1'|'A2') / GraphicsTrack ('V2'|'V3') literal unions.
// TimelineClip.trackId and Scene.track are now plain strings that reference
// a TimelineTrack.id here. Lives in shared/ (not project.ts) since it's a
// self-contained concept referenced from both the clip side (project.ts) and
// the scene side (templates.ts-adjacent code), avoiding an awkward import
// direction between those two.

export type TimelineTrackKind = 'video' | 'graphic' | 'text' | 'audio' | 'caption'

export interface TimelineTrack {
  id: string
  kind: TimelineTrackKind
  name: string
  /** Stacking/paint order. For video/graphic/text kinds, higher order paints
   * on top (see trackModel.ts's sortTracksForDisplay/resolveActiveVideoClip).
   * For audio/caption it's just list position -- no visual stacking meaning. */
  order: number
  height: number
  hidden: boolean
  locked: boolean
  muted?: boolean
  solo?: boolean
  collapsed?: boolean
  color?: string
  /** False only for the single fixed caption track -- every other track can
   * always be deleted (with confirmation if non-empty, enforced by the UI). */
  removable: boolean
  /** Explicit flag identifying THE primary video track for CapCut-style
   * magnetic/gapless editing (see renderer/src/timeline/magnet.ts) -- not
   * derived from `order` or `id` because both change under reorder/CRUD, and
   * a derived "lowest-order video track" would silently jump to a different
   * track after an unrelated reorder. Exactly 0 or 1 kind:'video' track has
   * this true at any time; trackModel.ts's removeTrack promotes the next
   * remaining video track when the main one is deleted, and duplicateTrack
   * never copies this flag onto the copy. */
  isMain?: boolean
}

export const MIN_TRACK_HEIGHT = 28
export const DEFAULT_VIDEO_TRACK_HEIGHT = 40
export const DEFAULT_AUDIO_TRACK_HEIGHT = 40
export const DEFAULT_GRAPHIC_TRACK_HEIGHT = 30
export const DEFAULT_CAPTION_TRACK_HEIGHT = 34

/** The six tracks every pre-dynamic-track project already implicitly used,
 * with the exact same ids -- shared verbatim by createNewProjectFile (brand
 * new projects) and migrateToTrackRegistry (schemaVersion 3 -> 4), so the two
 * paths can never drift apart. */
export function createDefaultTracks(): TimelineTrack[] {
  return [
    { id: 'V1', kind: 'video', name: 'Video 1', order: 0, height: DEFAULT_VIDEO_TRACK_HEIGHT, hidden: false, locked: false, removable: true, isMain: true },
    { id: 'V2', kind: 'graphic', name: 'Overlay', order: 0, height: DEFAULT_GRAPHIC_TRACK_HEIGHT, hidden: false, locked: false, removable: true },
    { id: 'V3', kind: 'graphic', name: 'Graphics', order: 1, height: DEFAULT_GRAPHIC_TRACK_HEIGHT, hidden: false, locked: false, removable: true },
    { id: 'A1', kind: 'audio', name: 'Narration', order: 0, height: DEFAULT_AUDIO_TRACK_HEIGHT, hidden: false, locked: false, muted: false, removable: true },
    { id: 'A2', kind: 'audio', name: 'Music', order: 1, height: DEFAULT_AUDIO_TRACK_HEIGHT, hidden: false, locked: false, muted: false, removable: true },
    { id: 'C1', kind: 'caption', name: 'Transcript', order: 0, height: DEFAULT_CAPTION_TRACK_HEIGHT, hidden: false, locked: false, removable: false }
  ]
}
