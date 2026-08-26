// Pure timeline-placement math used when a scene is newly ADDED (e.g. from
// the Template Library) so it never lands time-overlapping an existing scene
// on any track -- two full-frame graphics active at the same instant would
// render simultaneously and visually mix/stack in the Preview, regardless of
// which track each is on. Manual drag/retime on the timeline is a deliberate
// user action and is intentionally left free-form (not handled here).

export interface TimeRange {
  startTime: number
  endTime: number
}

/** Returns the earliest start time >= `desiredStart` (clamped to >= 0) at
 * which a clip of `duration` seconds does not overlap any range in
 * `existing`. If `desiredStart` is already clear, it's returned unchanged.
 * Otherwise the clip is pushed to start right after the colliding range
 * ends, repeating until no range overlaps (handles chains of back-to-back
 * existing clips). */
export function findNonOverlappingStart(existing: TimeRange[], desiredStart: number, duration: number): number {
  let start = Math.max(0, desiredStart)
  const sorted = [...existing].sort((a, b) => a.startTime - b.startTime)

  let pushed = true
  while (pushed) {
    pushed = false
    for (const range of sorted) {
      const overlaps = start < range.endTime && start + duration > range.startTime
      if (overlaps) {
        start = range.endTime
        pushed = true
      }
    }
  }

  return start
}
