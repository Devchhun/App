// Pure planning for routing a batch of AI-planned scenes onto graphics
// tracks without overlapping each other or anything already on the
// Timeline -- mirrors renderer/src/timeline/placementPlanning.ts's exact
// shape for multi-asset clip drops, reusing the SAME findOrCreateTrack
// collision-avoidance trackModel.ts already provides for every other kind
// of Timeline insertion (kind-agnostic: works identically for 'graphic' as
// it already does for 'video'/'audio').
import type { TimelineTrack } from '@shared/timelineTracks'
import type { ScenePlanScene } from '@shared/localAi'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'

export interface PlannedScenePlacement {
  scene: ScenePlanScene
  trackId: string
  newTrack?: TimelineTrack
}

/** Routes every scene in a plan to a free (or newly-created) graphics track,
 * processed in start-time order so two AI-proposed scenes that overlap each
 * other in time are guaranteed to land on separate tracks (spec section 6:
 * "place multiple overlapping templates on separate graphics tracks" /
 * "avoid unintended overlaps") -- and never on a track/time range something
 * already occupies (`occupied` seeds with every existing clip AND scene, so
 * "never overwrite existing clips" holds for both kinds, not just other
 * scenes). Locked tracks are skipped by findOrCreateTrack itself, so an
 * accepted/locked scene's track is never silently reused for something else. */
export function planScenePlacements(scenes: ScenePlanScene[], tracks: TimelineTrack[], occupied: OccupiedRange[]): PlannedScenePlacement[] {
  const placements: PlannedScenePlacement[] = []
  let workingTracks = tracks
  let workingOccupied = occupied

  const ordered = [...scenes].sort((a, b) => a.startTime - b.startTime)
  for (const scene of ordered) {
    const duration = Math.max(0.1, scene.endTime - scene.startTime)
    const routing = findOrCreateTrack(workingTracks, workingOccupied, scene.startTime, duration, 'graphic')
    if (routing.newTrack) workingTracks = [...workingTracks, routing.newTrack]
    placements.push({ scene, trackId: routing.trackId, newTrack: routing.newTrack })
    workingOccupied = [...workingOccupied, { trackId: routing.trackId, startTime: scene.startTime, endTime: scene.startTime + duration }]
  }

  return placements
}
