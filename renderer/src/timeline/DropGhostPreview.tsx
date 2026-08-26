import type { PlannedPlacement } from './placementPlanning'

interface Props {
  placements: PlannedPlacement[]
  pixelsPerSecond: number
  /** Cumulative pixel offset from the top of `.timeline-content` for each
   * track's row (see Timeline.tsx's `trackTopById`). A placement whose
   * track isn't in this map yet (a brand-new track the plan is about to
   * create) has no row to draw against and is skipped -- it still gets
   * created and filled on actual drop, just without a preview box beforehand. */
  trackTopById: Record<string, number>
  trackHeightById: Record<string, number>
}

/** Dashed-outline placeholders showing where each dragged Media asset will
 * land, recomputed on every dragover from the same planSequentialDrop/
 * planStackDrop functions the actual drop uses -- so the preview can never
 * show something the drop doesn't actually do. No thumbnails (deliberately
 * simplified per spec), just a labeled outline per asset. */
export function DropGhostPreview({ placements, pixelsPerSecond, trackTopById, trackHeightById }: Props): JSX.Element {
  return (
    <div className="drop-ghost-preview">
      {placements.map((p, i) => {
        const top = trackTopById[p.trackId]
        const height = trackHeightById[p.trackId]
        if (top === undefined || height === undefined) return null
        return (
          <div
            key={`${p.asset.mediaId}-${i}`}
            className="drop-ghost-box"
            style={{ left: p.startTime * pixelsPerSecond, top, width: Math.max(4, p.duration * pixelsPerSecond), height }}
          >
            {p.newTrack ? `New ${p.newTrack.kind} track` : ''}
          </div>
        )
      })}
    </div>
  )
}
