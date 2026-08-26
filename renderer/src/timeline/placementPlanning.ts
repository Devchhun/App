// Pure planning for dropping multiple selected Media assets onto the
// Timeline at once (Sequential vs Stack placement, see Timeline.tsx's
// drag-and-drop handler). Both the live ghost-preview (recomputed on every
// dragover) and the actual on-drop insertion call these same two functions,
// so the preview can never show something the drop doesn't actually do.
import type { TimelineTrack, TimelineTrackKind } from '@shared/timelineTracks'
import { findOrCreateTrack, type OccupiedRange } from './trackModel'
import { DEFAULT_IMAGE_DURATION_SECONDS } from '../sequence/sequenceOps'

export interface DropAsset {
  mediaId: string
  type: 'video' | 'image' | 'audio'
  /** Ignored for images (never source-bounded, see sequenceOps.ts). */
  sourceDurationSeconds: number
  hasAudio?: boolean
}

export interface PlannedPlacement {
  asset: DropAsset
  trackId: string
  newTrack?: TimelineTrack
  startTime: number
  duration: number
}

function kindForAsset(asset: DropAsset): TimelineTrackKind {
  return asset.type === 'audio' ? 'audio' : 'video'
}

function durationForAsset(asset: DropAsset): number {
  return asset.type === 'image' ? DEFAULT_IMAGE_DURATION_SECONDS : Math.max(0, asset.sourceDurationSeconds)
}

/** Default drop: assets placed back-to-back in time, each routed to a free
 * (or newly-created) track of its own kind -- `[Video 1][Image 1][Image
 * 2][Video 2]` all chain sequentially regardless of which track each one
 * ends up on. */
export function planSequentialDrop(assets: DropAsset[], dropTime: number, tracks: TimelineTrack[], occupied: OccupiedRange[]): PlannedPlacement[] {
  const placements: PlannedPlacement[] = []
  let cursor = Math.max(0, dropTime)
  let workingTracks = tracks
  let workingOccupied = occupied

  for (const asset of assets) {
    const duration = durationForAsset(asset)
    const routing = findOrCreateTrack(workingTracks, workingOccupied, cursor, duration, kindForAsset(asset))
    if (routing.newTrack) workingTracks = [...workingTracks, routing.newTrack]
    const placement: PlannedPlacement = { asset, trackId: routing.trackId, newTrack: routing.newTrack, startTime: cursor, duration }
    placements.push(placement)
    workingOccupied = [...workingOccupied, { trackId: routing.trackId, startTime: cursor, endTime: cursor + duration }]
    cursor += duration
  }

  return placements
}

/** Alt-drop: every asset starts at the same `dropTime`, each routed to its
 * own free (or newly-created) track of its own kind -- `V1: [Video
 * 1]` / `V2: [Image 1]` / `V3: [Image 2]` all simultaneously visible. */
export function planStackDrop(assets: DropAsset[], dropTime: number, tracks: TimelineTrack[], occupied: OccupiedRange[]): PlannedPlacement[] {
  const placements: PlannedPlacement[] = []
  const start = Math.max(0, dropTime)
  let workingTracks = tracks
  let workingOccupied = occupied

  for (const asset of assets) {
    const duration = durationForAsset(asset)
    const routing = findOrCreateTrack(workingTracks, workingOccupied, start, duration, kindForAsset(asset))
    if (routing.newTrack) workingTracks = [...workingTracks, routing.newTrack]
    placements.push({ asset, trackId: routing.trackId, newTrack: routing.newTrack, startTime: start, duration })
    workingOccupied = [...workingOccupied, { trackId: routing.trackId, startTime: start, endTime: start + duration }]
  }

  return placements
}
