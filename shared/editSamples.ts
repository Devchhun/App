import type { EditSample, NarrationSegment, SegmentMatch, Seconds, LearnedStyle } from './aiEditing'

/** How much of [aStart,aEnd) overlaps [bStart,bEnd), in seconds. */
function overlap(aStart: Seconds, aEnd: Seconds, bStart: Seconds, bEnd: Seconds): Seconds {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

let counter = 0
function sampleId(pairId: string): string {
  counter += 1
  return `${pairId}-s${counter}`
}

/**
 * Turn matched segments (and, when available, the edited narration) into
 * training examples. With narration, one sample per spoken line groups the
 * source scenes shown during it (the editing decision "what did I show while
 * saying this, and for how long"). Without narration, one sample per edited
 * shot, so the dataset is still useful before transcription.
 *
 * Pure and deterministic given its inputs; the id counter only affects ids.
 */
export function buildSamples(pairId: string, matches: SegmentMatch[], narration?: NarrationSegment[]): EditSample[] {
  const sorted = [...matches].sort((a, b) => a.editedStart - b.editedStart)

  if (narration && narration.length > 0) {
    return narration.map((line) => {
      const inLine = sorted.filter((m) => overlap(m.editedStart, m.editedEnd, line.start, line.end) > 0.05)
      const confidence = inLine.length ? Math.min(...inLine.map((m) => m.confidence)) : 0
      return {
        id: sampleId(pairId),
        pairId,
        narration: line,
        segments: inLine,
        editedDuration: round(line.end - line.start),
        cutCount: inLine.length,
        confidence: round(confidence),
      }
    })
  }

  // No narration: group by the edited shot each match fills.
  const byShot = new Map<number, SegmentMatch[]>()
  for (const m of sorted) {
    const key = m.editedShot ?? Math.round(m.editedStart * 1000)
    byShot.set(key, [...(byShot.get(key) ?? []), m])
  }
  return [...byShot.values()].map((group) => {
    const start = Math.min(...group.map((m) => m.editedStart))
    const end = Math.max(...group.map((m) => m.editedEnd))
    return {
      id: sampleId(pairId),
      pairId,
      segments: group,
      editedDuration: round(end - start),
      cutCount: group.length,
      confidence: round(Math.min(...group.map((m) => m.confidence))),
    }
  })
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Plain style numbers distilled from a set of samples — what the baseline
 * editor (Phase 3) follows and the UI shows. Computed over confident samples
 * only, so a few bad matches don't skew the pacing. */
export function learnStyle(samples: EditSample[], minConfidence = 0.4): LearnedStyle {
  const good = samples.filter((s) => s.confidence >= minConfidence && s.editedDuration > 0)
  if (good.length === 0) {
    return { medianHold: 0, cutsPerMinute: 0, cutOnNarration: 0, commonSpeeds: [] }
  }
  const holds = good.flatMap((s) => s.segments.map((m) => m.editedEnd - m.editedStart)).filter((d) => d > 0)
  const totalEdited = good.reduce((sum, s) => sum + s.editedDuration, 0)
  const totalCuts = good.reduce((sum, s) => sum + Math.max(1, s.cutCount), 0)
  const withNarration = good.filter((s) => s.narration)
  const onLine = withNarration.filter((s) => s.segments.some((m) => s.narration && Math.abs(m.editedStart - s.narration.start) < 0.4)).length

  return {
    medianHold: round(median(holds)),
    cutsPerMinute: round(totalEdited > 0 ? (totalCuts / totalEdited) * 60 : 0),
    cutOnNarration: round(withNarration.length ? onLine / withNarration.length : 0),
    commonSpeeds: commonSpeeds(good),
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function commonSpeeds(samples: EditSample[]): number[] {
  const counts = new Map<number, number>()
  for (const s of samples) {
    for (const m of s.segments) {
      const sp = m.transform?.speed
      if (sp && Math.abs(sp - 1) > 0.08) {
        const key = Math.round(sp * 10) / 10
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sp]) => sp)
}
