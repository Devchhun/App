// Pure, dependency-free project-file migration -- callable from the main
// process (projectStore.ts's loadProject) and directly testable without
// Electron. Kept separate from project.ts so it's obvious this is a one-way
// upgrade path, not part of the current schema's shape.
import type { ProjectFile, Scene, TimelineClip } from './project'
import { computeSequenceDuration } from './project'
import { createDefaultTracks } from './timelineTracks'

/** schemaVersion 1 -> 2: `SceneContentTransform.xPercent/yPercent` changed
 * from the box's top-left corner to its normalized CENTER (see
 * shared/templates.ts's SceneContentTransform doc comment). A project saved
 * under schema 1 has every scene's `contentTransform` reinterpreted here --
 * once, on load -- rather than silently moving scenes the next time they're
 * rendered. Any other schema-1 field is untouched. */
function migrateContentTransformToCenter(scene: Scene): Scene {
  if (!scene.contentTransform) return scene
  const t = scene.contentTransform
  return {
    ...scene,
    contentTransform: {
      ...t,
      xPercent: t.xPercent + t.widthPercent / 2,
      yPercent: t.yPercent + t.heightPercent / 2
    }
  }
}

/** schemaVersion 2 -> 3: introduces `ProjectSequence` -- the real multi-clip
 * V1/A1/A2 timeline. Older files have no `sequence` at all; the app's only
 * prior model was "one implicit selected media item plays as the whole
 * video," so that's exactly what gets converted into one V1 TimelineClip
 * spanning the asset's full duration (plus a linked A1 clip if it has
 * audio). An audio-only source becomes a single A1 clip instead. Never
 * deletes anything -- `project.scenes`/transcripts/captions are untouched
 * (their time values are already absolute-second, not media-relative). */
function migrateToSequence(project: ProjectFile): ProjectFile {
  const media = project.media[0]
  const clips: TimelineClip[] = []

  if (media) {
    const duration = media.durationSeconds
    if (media.kind === 'audio' && media.assetType !== 'video') {
      clips.push({
        id: crypto.randomUUID(),
        mediaId: media.id,
        type: 'audio',
        trackId: 'A1',
        startTime: 0,
        duration,
        sourceIn: 0,
        sourceOut: duration,
        locked: false
      })
    } else {
      const mainClipId = crypto.randomUUID()
      const mainType = media.assetType === 'image' ? 'image' : 'video'
      let linkedClipId: string | undefined
      if (media.hasAudio) {
        linkedClipId = crypto.randomUUID()
        clips.push({
          id: linkedClipId,
          mediaId: media.id,
          type: 'audio',
          trackId: 'A1',
          startTime: 0,
          duration,
          sourceIn: 0,
          sourceOut: duration,
          linkedClipId: mainClipId,
          locked: false
        })
      }
      clips.push({
        id: mainClipId,
        mediaId: media.id,
        type: mainType,
        trackId: 'V1',
        startTime: 0,
        duration,
        sourceIn: 0,
        sourceOut: mainType === 'image' ? undefined : duration,
        linkedClipId,
        locked: false
      })
    }
  }

  return {
    ...project,
    schemaVersion: 3,
    // tracks/markers are populated properly by the migration steps that
    // always run immediately after this one in the chain -- these empty
    // placeholders only exist to satisfy ProjectSequence's shape for the
    // instant in between.
    sequence: { tracks: [], clips, markers: [], duration: computeSequenceDuration(clips) }
  }
}

/** schemaVersion 3 -> 4: introduces the dynamic Timeline track registry
 * (`sequence.tracks`, see shared/timelineTracks.ts). Synthesizes exactly the
 * six fixed track ids every pre-4 project already implicitly used --
 * `createDefaultTracks()` is the same function brand-new projects call, so
 * the two paths can never drift apart -- meaning every existing clip's
 * `trackId` / scene's `track` string keeps matching a real track without
 * touching a single clip or scene. Idempotent: a project that already has a
 * non-empty track list is returned with just the version bump. */
function migrateToTrackRegistry(project: ProjectFile): ProjectFile {
  if (project.sequence.tracks && project.sequence.tracks.length > 0) {
    return { ...project, schemaVersion: 4 }
  }
  return {
    ...project,
    schemaVersion: 4,
    sequence: { ...project.sequence, tracks: createDefaultTracks() }
  }
}

/** schemaVersion 4 -> 5: introduces `sequence.markers` (real, persisted
 * Markers -- see shared/project.ts's Marker/ClipMarker) and
 * `TimelineTrack.isMain` (the primary video track for CapCut-style
 * magnetic/gapless editing -- see shared/timelineTracks.ts). Older files get
 * `markers: []` and `isMain: true` on whichever `kind:'video'` track has the
 * lowest `order` (matching migrateToTrackRegistry's own "preserve exactly
 * what a pre-dynamic-tracks project already implicitly meant" style -- V1
 * was always THE video track before this concept existed). Idempotent: a
 * project whose tracks already have an isMain flag and whose sequence
 * already has a markers array is returned with just the version bump. */
function migrateToMainTrackAndMarkers(project: ProjectFile): ProjectFile {
  const hasMain = project.sequence.tracks.some((t) => t.isMain)
  const hasMarkers = Array.isArray(project.sequence.markers)
  if (hasMain && hasMarkers) {
    return { ...project, schemaVersion: 5 }
  }

  let tracks = project.sequence.tracks
  if (!hasMain) {
    const firstVideo = tracks.filter((t) => t.kind === 'video').sort((a, b) => a.order - b.order)[0]
    tracks = tracks.map((t) => (t.id === firstVideo?.id ? { ...t, isMain: true } : t))
  }

  return {
    ...project,
    schemaVersion: 5,
    sequence: { ...project.sequence, tracks, markers: project.sequence.markers ?? [] }
  }
}

/** schemaVersion 5 -> 6: adds the optional `playbackRate`/`opacity`/`volume`/
 * `fadeIn`/`fadeOut`/`transform` fields on `TimelineClip` (see
 * shared/project.ts's ClipTransform doc comment). Every one of these is
 * optional and a missing value already means "the un-adjusted default" --
 * there is nothing to backfill on any existing clip, so this step is purely
 * the version bump. Kept as its own step (rather than folded into the bump
 * site) to match this file's one-function-per-version convention and give
 * this schema change its own place to grow if a future field here ever DOES
 * need a real backfill. */
function migrateToClipProperties(project: ProjectFile): ProjectFile {
  return { ...project, schemaVersion: 6 }
}

/** schemaVersion 6 -> 7: adds the optional `narrativeGraph`/`entityBible`/
 * `visualPlan`/`sceneGroups`/`theme` fields for AI Connected Story
 * Visualization (see shared/project.ts's doc comment, shared/story.ts). A
 * missing value always means "the user has never run story analysis for
 * this project" -- there is nothing to backfill, so this step is purely the
 * version bump plus defaulting each field to empty, matching
 * migrateToClipProperties's own "purely additive" style. */
function migrateToStoryVisualization(project: ProjectFile): ProjectFile {
  return {
    ...project,
    schemaVersion: 7,
    narrativeGraph: project.narrativeGraph ?? {},
    entityBible: project.entityBible ?? {},
    visualPlan: project.visualPlan ?? {},
    sceneGroups: project.sceneGroups ?? [],
    theme: project.theme ?? {}
  }
}

/** Upgrades a loaded project file to the current schema, forward-only,
 * chaining every applicable step in order. Idempotent to call on an
 * already-current file. Never mutates the input. */
export function migrateProjectFile(project: ProjectFile): ProjectFile {
  let result = project

  if (result.schemaVersion < 2) {
    result = { ...result, schemaVersion: 2, scenes: result.scenes.map(migrateContentTransformToCenter) }
  }

  if (result.schemaVersion < 3 || !result.sequence) {
    result = migrateToSequence(result)
  }

  if (result.schemaVersion < 4 || !result.sequence.tracks) {
    result = migrateToTrackRegistry(result)
  }

  if (result.schemaVersion < 5 || !result.sequence.markers) {
    result = migrateToMainTrackAndMarkers(result)
  }

  if (result.schemaVersion < 6) {
    result = migrateToClipProperties(result)
  }

  if (result.schemaVersion < 7 || !result.narrativeGraph || !result.entityBible || !result.visualPlan || !result.sceneGroups || !result.theme) {
    result = migrateToStoryVisualization(result)
  }

  return result
}
