import type { TranscriptSegment } from '@shared/transcription'

/** Where a dragged caption may actually land: never on top of another
 * caption. Same rule every other Timeline item follows (clips, graphics --
 * see sequenceOps.ts / sceneCollision.ts): two items on one row never
 * overlap in time.
 *
 * The requested start is kept when the block fits there. When it would
 * overlap, it is nudged to the nearest side of what it hit -- just after
 * the last overlapped caption, or just before the first -- whichever is
 * closer to where it was dropped, provided that spot is itself free. If
 * neither side has room the move is refused (`null`) and the caption stays
 * where it was, so a drop can never silently create an overlap. */
export function resolveSegmentMove(segments: readonly TranscriptSegment[], segmentId: string, requestedStart: number): number | null {
  const seg = segments.find((s) => s.id === segmentId)
  if (!seg) return null
  const duration = Math.max(0, seg.endTime - seg.startTime)
  const others = segments.filter((s) => s.id !== segmentId).sort((a, b) => a.startTime - b.startTime)

  const fits = (start: number): boolean => start >= 0 && !others.some((o) => o.startTime < start + duration && o.endTime > start)

  const start = Math.max(0, requestedStart)
  if (fits(start)) return start

  const hit = others.filter((o) => o.startTime < start + duration && o.endTime > start)
  const after = Math.max(...hit.map((o) => o.endTime))
  const before = Math.min(...hit.map((o) => o.startTime)) - duration
  const candidates = [after, before].filter((c) => fits(c)).sort((a, b) => Math.abs(a - start) - Math.abs(b - start))
  return candidates.length > 0 ? candidates[0] : null
}

/** Resolves one shared time delta for a group of selected captions. Their
 * internal spacing is never changed, and the whole set is kept at or after
 * zero without overlapping captions outside the selection. */
export function resolveSegmentSetMove(
  segments: readonly TranscriptSegment[],
  segmentIds: readonly string[],
  draggedSegmentId: string,
  requestedDraggedStart: number
): number | null {
  const ids = new Set(segmentIds)
  const selected = segments.filter((segment) => ids.has(segment.id))
  const dragged = selected.find((segment) => segment.id === draggedSegmentId)
  if (!dragged || selected.length === 0) return null

  const others = segments.filter((segment) => !ids.has(segment.id))
  const earliestStart = Math.min(...selected.map((segment) => segment.startTime))
  const minimumDelta = earliestStart === 0 ? 0 : -earliestStart
  const requestedDelta = Math.max(minimumDelta, requestedDraggedStart - dragged.startTime)
  const fits = (delta: number): boolean =>
    delta >= minimumDelta &&
    !selected.some((segment) =>
      others.some(
        (other) => other.startTime < segment.endTime + delta && other.endTime > segment.startTime + delta
      )
    )

  if (fits(requestedDelta)) return requestedDelta

  // Each collision-free resting place occurs at an outside caption edge.
  // Check all such edges and use the one nearest to the pointer request.
  const candidates = new Set<number>([minimumDelta, 0])
  for (const segment of selected) {
    for (const other of others) {
      candidates.add(other.endTime - segment.startTime)
      candidates.add(other.startTime - segment.endTime)
    }
  }
  const valid = [...candidates]
    .filter(fits)
    .sort((a, b) => Math.abs(a - requestedDelta) - Math.abs(b - requestedDelta))
  return valid[0] ?? null
}
