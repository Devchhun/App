import type { TimelineTrack } from '@shared/timelineTracks'

/** CapCut-style main-track anchoring (not a fixed gap below the ruler): the
 * main video track's own vertical CENTER (not the whole track group's) is
 * targeted at `topRatio / (topRatio + bottomRatio)` of the usable track-area
 * height -- a bit above true center ("leaning slightly upward" per the
 * reference design) when the main track is the only thing on the Timeline,
 * the overwhelmingly common starting case. Anchoring the main track
 * specifically (rather than centering the whole overlays+main+below-tracks
 * group) matters because a linked audio track under the main video, or any
 * other track below it, would otherwise pull the group's center down and
 * main up away from the target -- this keeps main's own position stable
 * regardless of what surrounds it, as long as it all still fits.
 *
 * Both spacer heights are clamped to >=0: once the tracks above/below main
 * are tall enough on their own to exceed the target region, the
 * corresponding spacer collapses and the track area grows past its
 * `usableHeight` budget -- the ancestor scroll container takes over from
 * there, same as it always has for a Timeline with many tracks. */
export function computeTrackCentering(
  sortedTracks: TimelineTrack[],
  trackHeightById: Record<string, number>,
  usableHeight: number,
  topRatio: number,
  bottomRatio: number
): { topSpacerHeight: number; bottomSpacerHeight: number } {
  const mainIndex = sortedTracks.findIndex((t) => t.isMain)
  if (mainIndex === -1) {
    // No main track to anchor to (shouldn't happen once the Timeline isn't
    // empty, since visibleTracksForDisplay always shows it) -- split
    // evenly by the same ratio as a reasonable fallback.
    const totalHeight = sortedTracks.reduce((sum, t) => sum + trackHeightById[t.id], 0)
    const freeSpace = Math.max(0, usableHeight - totalHeight)
    return { topSpacerHeight: (freeSpace * topRatio) / (topRatio + bottomRatio), bottomSpacerHeight: (freeSpace * bottomRatio) / (topRatio + bottomRatio) }
  }

  const overlaysHeight = sortedTracks.slice(0, mainIndex).reduce((sum, t) => sum + trackHeightById[t.id], 0)
  const mainHeight = trackHeightById[sortedTracks[mainIndex].id]
  const belowHeight = sortedTracks.slice(mainIndex + 1).reduce((sum, t) => sum + trackHeightById[t.id], 0)

  const topFraction = topRatio / (topRatio + bottomRatio)
  const topSpacerHeight = Math.max(0, topFraction * usableHeight - mainHeight / 2 - overlaysHeight)
  const bottomSpacerHeight = Math.max(0, usableHeight - topSpacerHeight - overlaysHeight - mainHeight - belowHeight)

  return { topSpacerHeight, bottomSpacerHeight }
}
