// Pure placement routing for accepted StoryBeats -- mirrors
// renderer/src/scenes/scenePlacementPlanning.ts's exact shape one level up
// (that file routes ScenePlanScene[]; this one routes StoryBeat[]), reusing
// the SAME findOrCreateTrack collision-avoidance trackModel.ts already
// provides for every other kind of Timeline insertion.
import type { TimelineTrack } from '@shared/timelineTracks'
import type { StoryBeat } from '@shared/story'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'

export interface PlannedStoryBeatPlacement {
  beat: StoryBeat
  trackId: string
  newTrack?: TimelineTrack
}

/** Routes every accepted beat to a free (or newly-created) graphics track,
 * processed in start-time order so two connected beats that overlap in time
 * (a deliberate continuity overlap, per Section 8/9) land on separate
 * tracks instead of colliding -- and never on a track/time range something
 * already occupies. Locked tracks are skipped by findOrCreateTrack itself. */
export function planStoryBeatPlacements(beats: StoryBeat[], tracks: TimelineTrack[], occupied: OccupiedRange[]): PlannedStoryBeatPlacement[] {
  const placements: PlannedStoryBeatPlacement[] = []
  let workingTracks = tracks
  let workingOccupied = occupied

  const ordered = [...beats].sort((a, b) => a.startTime - b.startTime)
  for (const beat of ordered) {
    const duration = Math.max(0.1, beat.endTime - beat.startTime)
    const routing = findOrCreateTrack(workingTracks, workingOccupied, beat.startTime, duration, 'graphic')
    if (routing.newTrack) workingTracks = [...workingTracks, routing.newTrack]
    placements.push({ beat, trackId: routing.trackId, newTrack: routing.newTrack })
    workingOccupied = [...workingOccupied, { trackId: routing.trackId, startTime: beat.startTime, endTime: beat.startTime + duration }]
  }

  return placements
}
