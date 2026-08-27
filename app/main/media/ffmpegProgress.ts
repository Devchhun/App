/** Finds the LAST complete `out_time_ms=<microseconds>` line among `lines`
 * (already split on '\n', with any trailing partial line removed by the
 * caller) and converts it to a 0-100 percent against `totalDurationSeconds`.
 * Extracted from jobRunner.ts's stdout handler for testability -- this is
 * the exact spot a prior version's O(n^2) full-buffer rescan on every chunk
 * lived, which could visibly stall percent updates on long files. */
export function parseFfmpegProgressPercent(lines: string[], totalDurationSeconds: number): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('out_time_ms=')) continue
    // ffmpeg's `-progress` out_time_ms field is actually in microseconds.
    const outTimeMicros = Number(lines[i].split('=')[1])
    if (!Number.isFinite(outTimeMicros)) return null
    return Math.min(100, (outTimeMicros / 1_000_000 / totalDurationSeconds) * 100)
  }
  return null
}
