/** Picks a "nice" tick interval (in seconds) so labels don't overlap at any zoom level. */
export function pickTickInterval(pixelsPerSecond: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900]
  const minPxPerTick = 70
  for (const candidate of candidates) {
    if (candidate * pixelsPerSecond >= minPxPerTick) return candidate
  }
  return candidates[candidates.length - 1]
}

/** How many minor (unlabeled, shorter) ticks render between each major
 * (labeled) tick -- purely visual, CapCut-style subdivision, no effect on
 * `pickTickInterval`'s own major-spacing math. */
export const MINOR_TICKS_PER_MAJOR = 5

/** Major (labeled) and minor (unlabeled) tick times, in seconds, for the
 * given visible range. `Math.ceil` deliberately renders one tick past the
 * visible edge so scrolling doesn't pop a fresh one in right at the
 * boundary -- but when `rangeEnd` is capped by `duration` itself (not by
 * viewEnd, i.e. the ruler's actual end is on screen), that extra tick would
 * land past `duration * pixelsPerSecond`, the ruler's own CSS width,
 * rendering a timestamp floating outside the ruler's background entirely.
 * Filtering to `t <= duration` keeps the smooth-scroll rendering everywhere
 * else while never producing a tick past the ruler's real right edge. */
export function computeRulerTicks(
  duration: number,
  pixelsPerSecond: number,
  rangeStart: number,
  rangeEnd: number
): { majorTicks: number[]; minorTicks: number[] } {
  const interval = pickTickInterval(pixelsPerSecond)

  const firstMajorIndex = Math.floor(rangeStart / interval)
  const lastMajorIndex = Math.ceil(rangeEnd / interval)
  const majorTicks: number[] = []
  for (let i = firstMajorIndex; i <= lastMajorIndex; i++) {
    const t = i * interval
    if (t <= duration) majorTicks.push(t)
  }

  const minorStep = interval / MINOR_TICKS_PER_MAJOR
  const firstMinorIndex = Math.floor(rangeStart / minorStep)
  const lastMinorIndex = Math.ceil(rangeEnd / minorStep)
  const minorTicks: number[] = []
  for (let i = firstMinorIndex; i <= lastMinorIndex; i++) {
    const t = i * minorStep
    if (i % MINOR_TICKS_PER_MAJOR !== 0 && t <= duration) minorTicks.push(t)
  }

  return { majorTicks, minorTicks }
}
