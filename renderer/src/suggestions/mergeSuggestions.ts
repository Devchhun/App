import type { AiSuggestion } from '@shared/suggestions'
import type { TranscriptSegment } from '@shared/transcription'

/** Splits segments into ones whose existing suggestion must survive a bulk
 * regeneration untouched (accepted, locked, or manually edited) versus ones
 * that are safe to re-classify. Pure and framework-free so it's directly
 * unit-testable without mounting any React state. */
export function partitionSegmentsForRegeneration(
  segments: TranscriptSegment[],
  existing: AiSuggestion[]
): { toPreserve: AiSuggestion[]; toClassify: TranscriptSegment[] } {
  const bySegmentId = new Map(existing.map((s) => [s.segmentId, s]))
  const toPreserve: AiSuggestion[] = []
  const toClassify: TranscriptSegment[] = []

  for (const seg of segments) {
    const suggestion = bySegmentId.get(seg.id)
    if (suggestion && (suggestion.status === 'accepted' || suggestion.locked || suggestion.edited)) {
      toPreserve.push(suggestion)
    } else {
      toClassify.push(seg)
    }
  }

  return { toPreserve, toClassify }
}

/** Combines preserved suggestions with freshly generated ones, in timeline order. */
export function mergeSuggestions(preserved: AiSuggestion[], fresh: AiSuggestion[]): AiSuggestion[] {
  return [...preserved, ...fresh].sort((a, b) => a.startTime - b.startTime)
}

/** Splices a single regenerated/simplified suggestion back into a list,
 * replacing the prior suggestion for that segment (or appending if there
 * wasn't one) without disturbing any other entry's order or identity. */
export function spliceSuggestion(existing: AiSuggestion[], updated: AiSuggestion): AiSuggestion[] {
  const index = existing.findIndex((s) => s.segmentId === updated.segmentId)
  if (index === -1) {
    return [...existing, updated].sort((a, b) => a.startTime - b.startTime)
  }
  const next = [...existing]
  next[index] = updated
  return next
}
