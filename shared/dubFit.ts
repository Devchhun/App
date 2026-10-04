/** Fitting dubbed lines to their subtitles -- the desktop's AI Dubber
 * (renderer/src/dubbing/dubbingPlan.ts) and the phone's Captions & Dub. */

/** The most Auto-Speed will speed a line up. It used to make every line fit
 * exactly, with no limit: a 3 s line in a 1 s slot played at 3x, and past
 * the first minutes of an episode (where overruns pile up) the voice turned
 * into an unclear gabble. Past this a line keeps its natural pace and runs
 * a little late instead (planAutoSync). */
export const AUTO_SPEED_MAX = 1.25

/** Speed-up Auto-Speed gives one clip, or null to leave it as it is: it
 * fits, it would gain too little, or it was already sped up once (pressing
 * Auto-Speed again used to speed the sped-up file again, compounding). */
export function autoSpeedFor(clipSeconds: number, availableSeconds: number, alreadyRefit: boolean): number | null {
  if (alreadyRefit || availableSeconds <= 0) return null
  const needed = clipSeconds / availableSeconds
  if (needed <= 1.02) return null
  return Math.round(Math.min(AUTO_SPEED_MAX, needed) * 1000) / 1000
}

/** Auto-Sync: every line back on its subtitle's start -- but never before
 * the previous line has finished (plus a breath), so two lines never talk
 * over each other. Returns only the clips that move. */
export function planAutoSync(lines: { clipId: string; subtitleStart: number; clipStart: number; clipSeconds: number }[], breathSeconds = 0.05): { clipId: string; startTime: number }[] {
  const moves: { clipId: string; startTime: number }[] = []
  let previousEnd = Number.NEGATIVE_INFINITY
  for (const line of [...lines].sort((a, b) => a.subtitleStart - b.subtitleStart)) {
    const start = Math.max(line.subtitleStart, previousEnd + breathSeconds)
    if (Math.abs(line.clipStart - start) > 0.001) moves.push({ clipId: line.clipId, startTime: Math.round(start * 1000) / 1000 })
    previousEnd = start + line.clipSeconds
  }
  return moves
}
