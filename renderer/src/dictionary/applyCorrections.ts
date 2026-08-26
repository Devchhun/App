import type { TranscriptSegment, CorrectionDictionaryEntry, CorrectionMatch } from '@shared/transcription'

/** Finds every occurrence of every enabled dictionary entry's `original` text
 * within each segment's current display text (editedText ?? text). Pure and
 * read-only -- callers decide whether/how to apply the results. */
export function findCorrectionMatches(
  segments: TranscriptSegment[],
  entries: CorrectionDictionaryEntry[]
): CorrectionMatch[] {
  const enabledEntries = entries.filter((e) => e.enabled && e.original.length > 0)
  if (enabledEntries.length === 0) return []

  const matches: CorrectionMatch[] = []
  for (const segment of segments) {
    const text = segment.editedText ?? segment.text
    for (const entry of enabledEntries) {
      let searchFrom = 0
      while (true) {
        const index = text.indexOf(entry.original, searchFrom)
        if (index === -1) break
        matches.push({ entryId: entry.id, segmentId: segment.id, original: entry.original, correction: entry.correction, index })
        searchFrom = index + entry.original.length
      }
    }
  }
  return matches
}

/** Applies a set of previously-previewed matches, replacing every occurrence
 * (not just the ones in `matches`, to keep behavior predictable when the
 * same original text appears more than once) and returns the new text per
 * segment id. Segment start/end timing is never touched by this function --
 * callers should only write the returned text back via a text-only update. */
export function applyMatchesToSegments(
  segments: TranscriptSegment[],
  matches: CorrectionMatch[]
): Map<string, string> {
  const bySegment = new Map<string, CorrectionMatch[]>()
  for (const match of matches) {
    const list = bySegment.get(match.segmentId) ?? []
    list.push(match)
    bySegment.set(match.segmentId, list)
  }

  const updatedTextBySegment = new Map<string, string>()
  for (const segment of segments) {
    const segmentMatches = bySegment.get(segment.id)
    if (!segmentMatches || segmentMatches.length === 0) continue
    let text = segment.editedText ?? segment.text
    const uniqueReplacements = new Map(segmentMatches.map((m) => [m.original, m.correction]))
    for (const [original, correction] of uniqueReplacements) {
      text = text.split(original).join(correction)
    }
    updatedTextBySegment.set(segment.id, text)
  }
  return updatedTextBySegment
}
