/** Where the Detect Gender review opens: where it was left, not line 1.
 *
 * The place is kept per story (its video) in localStorage, so it is still
 * there after the window is reloaded or the app restarted -- a review of
 * 300 lines is done in several sittings, and it used to start over at the
 * first line (or the selected one) every time it was opened. */

const RESUME_KEY = 'cae-detect-gender-resume-v1'
/** Stories remembered; the least recently reviewed go first. */
const STORIES_KEPT = 60

export interface ReviewPlace {
  /** The line the review was showing. */
  segmentId: string
  /** The subtitle selected in the script at that time: a different one
   * selected since means the user has pointed at another line. */
  selectedThen: string | null
  /** When (ms), for dropping the oldest. */
  at: number
}

function readAll(): Record<string, ReviewPlace> {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ReviewPlace>) : {}
  } catch {
    return {}
  }
}

export function loadReviewPlace(storyKey: string): ReviewPlace | null {
  const place = readAll()[storyKey]
  return place && typeof place.segmentId === 'string' ? place : null
}

export function saveReviewPlace(storyKey: string, segmentId: string, selectedThen: string | null): void {
  if (!storyKey) return
  try {
    const all = readAll()
    all[storyKey] = { segmentId, selectedThen, at: Date.now() }
    const kept = Object.entries(all)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, STORIES_KEPT)
    localStorage.setItem(RESUME_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Without storage the review simply opens by the other rules.
  }
}

/** The line (index into `segmentIds`) the review opens on:
 *   1. a subtitle the user selected since the review was last left -- they
 *      pointed at it;
 *   2. the line the review was left on;
 *   3. never reviewed here (or that line is gone): the selected subtitle
 *      when it has no voice picked by hand yet, else the first line that
 *      has none -- so a review started before places were remembered
 *      still continues where its picks stop;
 *   4. every line picked: the selected subtitle, else the first line. */
export function reviewStartIndex(segmentIds: string[], pickedByHand: (segmentId: string) => boolean, place: ReviewPlace | null, selectedId: string | null): number {
  const indexOf = (id: string | null | undefined): number => (id ? segmentIds.indexOf(id) : -1)
  const selected = indexOf(selectedId)
  const left = indexOf(place?.segmentId)
  if (left >= 0) return selected >= 0 && selectedId !== place?.selectedThen ? selected : left
  if (selected >= 0 && !pickedByHand(segmentIds[selected])) return selected
  const firstOpen = segmentIds.findIndex((id) => !pickedByHand(id))
  if (firstOpen >= 0) return firstOpen
  return Math.max(0, selected)
}
