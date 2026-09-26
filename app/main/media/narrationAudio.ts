import { unlink, rename } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import type { NarrationOptimizationSettings } from '@shared/narration'

/** Leading/trailing silence trim, expressed as ffmpeg's own reverse-trim-
 * reverse idiom (silenceremove only ever trims from the START of a stream,
 * so trimming the tail means reversing, trimming, and reversing back). Only
 * removes genuinely silent samples at the two ends -- never touches anything
 * once real (voiced) audio has started, so it can't cut words or alter
 * timing/speed of the spoken content itself. */
const SILENCE_TRIM_FILTER =
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,areverse,' +
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,areverse'

/** Short fades applied via ffmpeg's reverse trick for the fade-OUT half, so
 * this never needs to know the clip's total duration up front (the filter
 * graph is built once, independent of any specific file). Purely an
 * amplitude envelope at the very edges -- doesn't affect pitch or speed. */
const FADE_FILTER = 'afade=t=in:d=0.05,areverse,afade=t=in:d=0.05,areverse'

/** Spectral noise reduction -- amplitude/spectrum only, never pitch-shifts
 * or time-stretches. */
const NOISE_REDUCTION_FILTER = 'afftdn'

/** Gentle automatic gain leveling -- amplitude only. Applied before the
 * final loudness normalization pass so an unevenly-leveled take is smoothed
 * out first, then normalized as a whole. */
const AUTO_GAIN_FILTER = 'dynaudnorm'

/** Loudness normalization to a broadcast-typical target -- amplitude only,
 * applied last so it measures/targets the take after every other filter
 * has already shaped it. */
const LOUDNESS_NORMALIZE_FILTER = 'loudnorm=I=-16:LRA=11:TP=-1.5'

/** Combines only the ENABLED steps into one single-pass ffmpeg filter graph,
 * in a fixed, sensible order (trim -> denoise -> auto-gain -> loudness ->
 * fade). Returns null when nothing is enabled at all, so the caller can skip
 * running ffmpeg entirely rather than doing a wasteful no-op re-encode. Pure
 * and independently testable -- no ffmpeg process involved. */
export function buildNarrationFilterGraph(settings: NarrationOptimizationSettings): string | null {
  const steps: string[] = []
  if (settings.trimSilence) steps.push(SILENCE_TRIM_FILTER)
  if (settings.noiseReduction) steps.push(NOISE_REDUCTION_FILTER)
  if (settings.autoGain) steps.push(AUTO_GAIN_FILTER)
  if (settings.loudnessNormalize) steps.push(LOUDNESS_NORMALIZE_FILTER)
  if (settings.fadeInOut) steps.push(FADE_FILTER)
  return steps.length > 0 ? steps.join(',') : null
}

/** Applies the enabled optimization steps to `filePath` IN PLACE, via the
 * same temp-file-then-rename convention as every other ffmpeg-writing step
 * in this codebase (audioExtract.ts, media.ts's webm remux) -- never leaves
 * a half-written file behind, and the original is untouched if anything
 * fails partway through. A no-op (returns `applied: false` immediately, no
 * ffmpeg spawned) when every setting is off. */
export async function optimizeNarrationTake(jobId: string, filePath: string, settings: NarrationOptimizationSettings): Promise<{ applied: boolean }> {
  const filterGraph = buildNarrationFilterGraph(settings)
  if (!filterGraph) return { applied: false }

  const tmpPath = `${filePath}.${jobId}.tmp.webm`
  try {
    // Audio-only input (a MediaRecorder .webm take, no video stream) --
    // applying an audio filter always requires decode+re-encode, so this
    // re-encodes to Opus (the format these takes are already recorded in)
    // rather than attempting a `-c:v copy` that has no video stream to copy.
    await runFfmpeg(jobId, ['-y', '-i', filePath, '-af', filterGraph, '-c:a', 'libopus', tmpPath])
    await rename(tmpPath, filePath)
    return { applied: true }
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
