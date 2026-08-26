// Pure logic for the Visual Plan's "Merge with previous beat" / "Split into
// two beats" actions (spec Section 3). Kept separate from StoryContext.tsx
// so both are directly testable without React, matching this codebase's
// established pure-module convention (e.g. renderer/src/timeline/trackModel.ts).
import type { StoryBeat, StoryBeatImportance } from '@shared/story'

const IMPORTANCE_RANK: Record<StoryBeatImportance, number> = { supporting: 0, important: 1, critical: 2 }

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}

/** Combines two adjacent beats (`first` immediately before `second`) into
 * one. The merged beat keeps `first`'s id/title/recommendedVisualization
 * (the earlier beat's framing wins) but unions every reference list and
 * concatenates the summaries so nothing either beat referenced is silently
 * dropped -- the user can still edit the result afterward (Section 10: "the
 * user must always remain able to edit AI decisions"). Does not validate
 * that the beats are actually adjacent/ordered; callers pass beats in the
 * order they want merged. */
export function mergeStoryBeats(first: StoryBeat, second: StoryBeat): StoryBeat {
  return {
    id: first.id,
    startTime: Math.min(first.startTime, second.startTime),
    endTime: Math.max(first.endTime, second.endTime),
    segmentIds: dedupe([...first.segmentIds, ...second.segmentIds]),
    title: first.title,
    summary: [first.summary, second.summary].filter(Boolean).join(' '),
    purpose: first.purpose,
    entities: dedupe([...first.entities, ...second.entities]),
    relations: dedupe([...first.relations, ...second.relations]),
    evidence: first.evidence || second.evidence ? dedupe([...(first.evidence ?? []), ...(second.evidence ?? [])]) : undefined,
    recommendedVisualization: first.recommendedVisualization,
    importance: IMPORTANCE_RANK[first.importance] >= IMPORTANCE_RANK[second.importance] ? first.importance : second.importance
  }
}

export interface SegmentTimeLookup {
  [segmentId: string]: { startTime: number; endTime: number }
}

/** Splits one beat into two at `atTime`. Returns null when `atTime` isn't
 * strictly inside the beat's own time range (nothing sensible to split).
 * `segmentTimes` (real TranscriptSegment start/end times) is used to
 * partition `segmentIds` by which half of the split each segment's midpoint
 * falls into -- a segment with no entry in the lookup (shouldn't happen for
 * a validated beat, but never crashes) stays in the first half. Entities and
 * relations are deliberately copied to BOTH halves rather than guessed-split
 * -- there's no reliable signal for which half a relationship belongs to
 * from time range alone, so this leaves it as an explicit, visible thing for
 * the user to edit in the Visual Plan rather than silently dropping either
 * half's context. */
export function splitStoryBeat(beat: StoryBeat, atTime: number, segmentTimes: SegmentTimeLookup): [StoryBeat, StoryBeat] | null {
  if (atTime <= beat.startTime || atTime >= beat.endTime) return null

  const firstSegments: string[] = []
  const secondSegments: string[] = []
  for (const segId of beat.segmentIds) {
    const t = segmentTimes[segId]
    const midpoint = t ? (t.startTime + t.endTime) / 2 : beat.startTime
    if (midpoint < atTime) firstSegments.push(segId)
    else secondSegments.push(segId)
  }
  // Never produce an empty half's segment list when the source beat had
  // segments to distribute -- fall back to keeping at least one on each side
  // so neither half is orphaned from the transcript entirely.
  if (firstSegments.length === 0 && beat.segmentIds.length > 0) firstSegments.push(beat.segmentIds[0])
  if (secondSegments.length === 0 && beat.segmentIds.length > 1) secondSegments.push(beat.segmentIds[beat.segmentIds.length - 1])

  const first: StoryBeat = {
    ...beat,
    id: `${beat.id}-a`,
    endTime: atTime,
    segmentIds: dedupe(firstSegments),
    title: `${beat.title} (Part 1)`
  }
  const second: StoryBeat = {
    ...beat,
    id: `${beat.id}-b`,
    startTime: atTime,
    segmentIds: dedupe(secondSegments),
    title: `${beat.title} (Part 2)`
  }
  return [first, second]
}
