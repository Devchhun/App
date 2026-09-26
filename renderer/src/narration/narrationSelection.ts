import type { TranscriptSegment } from '@shared/transcription'
import type { NarrationSegmentState } from '@shared/narration'

/** "Accept & Next"'s advancement rule: the next segment, in file order, past
 * `currentIndex`, that hasn't already been accepted -- skips segments the
 * user already recorded and accepted (so re-visiting the list doesn't
 * regress), but does NOT skip 'pending'/'recorded'/'needs-review' ones
 * (a take mid-review that was Redo'd, or one flagged for review, should
 * still come up again in order). Returns null once nothing pending remains
 * after `currentIndex`. Never wraps around to the start -- Accept & Next
 * only ever moves forward; the user can always jump back manually via the
 * segment list or Previous. */
export function findNextPendingSegment(
  segments: TranscriptSegment[],
  currentIndex: number,
  segmentStates: Record<string, NarrationSegmentState>
): TranscriptSegment | null {
  for (let i = currentIndex + 1; i < segments.length; i++) {
    if (segmentStates[segments[i].id]?.status !== 'accepted') return segments[i]
  }
  return null
}
