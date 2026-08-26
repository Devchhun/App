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

/** Every track id actually referenced by a clip or a scene -- the input to
 * pruneEmptyTracks below. Generic over minimal shapes (not the real
 * TimelineClip/Scene types) so this file never has to import from
 * project.ts, which itself imports FROM this file (createDefaultTracks) --
 * an import the other direction would be circular. */
export function usedTrackIds(clips: readonly { trackId: string }[], scenes: readonly { track: string }[]): Set<string> {
  const ids = new Set<string>()
  for (const c of clips) ids.add(c.trackId)
  for (const s of scenes) ids.add(s.track)
  return ids
}

/** Drops any track that has nothing on it AND isn't structurally required --
 * the current main video track (isMain, so there's always an obvious primary
 * drop target even in an otherwise audio/graphics-only project) and the one
 * fixed caption track (removable:false, a separate always-on feature surface
 * tied to the Transcript import feature, not "clutter") are kept even when
 * empty; every other empty track -- an unused Overlay/Graphics/Music track
 * the project never ended up needing, or debris a past bug left behind (e.g.
 * the auto-create-a-new-track-per-pointermove drag bug ClipTrack.tsx used to
 * have) -- is removed.
 *
 * Applied once, at project LOAD time only (see projectStore.ts's
 * loadProject), never during live editing -- a track the user just added
 * this session and hasn't put anything on yet must survive for the rest of
 * that session; it only disappears the next time the project is reopened, by
 * which point "still empty" really does mean "never got used." This keeps
 * "reopening a project never appends blank tracks" and "unused tracks
 * eventually get cleaned up" both true without either fighting live editing
 * or silently deleting a track mid-session out from under the user. */
export function pruneEmptyTracks(tracks: readonly TimelineTrack[], usedIds: ReadonlySet<string>): TimelineTrack[] {
  return tracks.filter((t) => usedIds.has(t.id) || t.isMain || !t.removable)
}
