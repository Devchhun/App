import type { TimelineTrack } from '@shared/timelineTracks'

/** How tall the protected empty band between the ruler and the first track
 * row is allowed to be right now.
 *
 * At its full `maxSafeZone` it costs that much on top of the ruler before a
 * single track row can start -- fine on a normal panel, but when the
 * Timeline is dragged down to a sliver, that fixed chrome is most of the
 * panel and the rows it pushes down go straight off the bottom, leaving the
 * user staring at an empty band with their clips scrolled out of sight. So
 * it only keeps whatever's left after the ruler and the track rows have
 * taken their share, down to 0 -- the rows are the point of the panel; the
 * gap above them is a luxury.
 *
 * `viewportHeight <= 0` means "not measured yet" (first paint, before the
 * caller's layout effect runs), NOT "no room at all" -- the full band is
 * kept so it doesn't visibly collapse and re-expand on mount. */
export function computeSafeZoneHeight(viewportHeight: number, rulerHeight: number, totalRowsHeight: number, maxSafeZone: number): number {
  if (viewportHeight <= 0) return maxSafeZone
  return Math.max(0, Math.min(maxSafeZone, viewportHeight - rulerHeight - totalRowsHeight))
}

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
 * Purely proportional to `usableHeight`, with no fixed-pixel ceiling on
 * either spacer -- a Timeline panel on a large monitor and one on a laptop
 * both land the main track at the same target FRACTION of their own usable
 * height, which is what "vertically centered" actually means. (An earlier
 * version capped the top spacer at a fixed pixel value to keep a tall panel
 * from stretching the ruler-to-first-row gap; that cap itself became the
 * bug it was working around -- past the cap, ALL of the panel's extra
 * height spilled into the bottom spacer instead of splitting proportionally,
 * so the main track drifted up toward the ruler on any panel tall enough to
 * hit it, which is exactly "not centered" on a large monitor. The caller is
 * responsible for re-measuring `usableHeight` from the real viewport
 * (ResizeObserver) so this always recomputes from the actual space
 * available, on any monitor size or OS display-scaling factor.)
 *
 * Spacer heights are clamped to >=0 (or the optional trailing minimum): once the tracks above/below main
 * are tall enough on their own to exceed the target region, the
 * corresponding spacer collapses and the track area grows past its
 * `usableHeight` budget -- the ancestor scroll container takes over from
 * there, same as it always has for a Timeline with many tracks. */
export function computeTrackCentering(
  sortedTracks: TimelineTrack[],
  trackHeightById: Record<string, number>,
  usableHeight: number,
  topRatio: number,
  bottomRatio: number,
  minimumBottomSpacer = 0
): { topSpacerHeight: number; bottomSpacerHeight: number } {
  const mainIndex = sortedTracks.findIndex((t) => t.isMain)
  if (mainIndex === -1) {
    // No main track to anchor to (shouldn't happen once the Timeline isn't
    // empty, since visibleTracksForDisplay always shows it) -- split
    // evenly by the same ratio as a reasonable fallback.
    const totalHeight = sortedTracks.reduce((sum, t) => sum + trackHeightById[t.id], 0)
    const freeSpace = Math.max(0, usableHeight - totalHeight)
    const topSpacerHeight = (freeSpace * topRatio) / (topRatio + bottomRatio)
    return { topSpacerHeight, bottomSpacerHeight: Math.max(minimumBottomSpacer, freeSpace - topSpacerHeight) }
  }

  const overlaysHeight = sortedTracks.slice(0, mainIndex).reduce((sum, t) => sum + trackHeightById[t.id], 0)
  const mainHeight = trackHeightById[sortedTracks[mainIndex].id]
  const belowHeight = sortedTracks.slice(mainIndex + 1).reduce((sum, t) => sum + trackHeightById[t.id], 0)

  const topFraction = topRatio / (topRatio + bottomRatio)
  const topSpacerHeight = Math.max(0, topFraction * usableHeight - mainHeight / 2 - overlaysHeight)
  // Keep a small trailing breathing area when requested by the Timeline.
  // Once rows overflow, this intentionally extends the scrollable content
  // instead of leaving the last row glued to the bottom edge.
  const bottomSpacerHeight = Math.max(
    minimumBottomSpacer,
    usableHeight - topSpacerHeight - overlaysHeight - mainHeight - belowHeight
  )

  return { topSpacerHeight, bottomSpacerHeight }
}
