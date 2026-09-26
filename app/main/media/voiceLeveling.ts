import { unlink } from 'fs/promises'
import { runFfmpeg } from './jobRunner'
import { computeMasterGainDb, measureLineLoudness } from './dubbingMaster'

/** "Even voice": makes a recording sit at one steady level with nothing
 * poking over the top. Used on a My Voice reference clip before it is
 * cloned from (an unevenly-recorded reference clones unevenly -- the model
 * copies the loud words and the dropped words alike, take after take) and
 * on a finished Recap narration (so one paragraph never comes out louder
 * than the next).
 *
 * Two passes, on purpose: trimming and (for a narration) compressing
 * change the loudness, so the gain that puts the result on target can only
 * be measured AFTER them. The compressor is gentle (3:1 over -22 dB,
 * slow-ish release) -- it evens out word-to-word swings without flattening
 * the expression; the limiter is a ceiling, not the leveler. */

export interface VoiceLevelOptions {
  /** Integrated loudness the result is brought to. */
  targetLufs: number
  /** True-peak ceiling the result is held under. */
  ceilingDb: number
  /** Drop dead air before the first word and after the last. */
  trimEdges: boolean
  /** Even out word-to-word swings with a gentle compressor. Never for a
   * cloning reference: the model copies the timbre it is given, and a
   * compressed clip clones as a tighter, flatter voice than the person
   * actually has -- a reference gets a linear gain and a ceiling only. */
  compress: boolean
  /** Cap the output length (seconds) -- a reference clip is cut to the
   * length the model clones best from, AFTER the edges are trimmed so the
   * cut keeps speech rather than silence. */
  maxSeconds?: number
}

/** Reference clip: a touch quieter than dialogue so the model sees a
 * natural speaking level, and a firm peak ceiling so a clipped reference
 * can never teach the model to clip. */
export const REFERENCE_LEVEL: VoiceLevelOptions = { targetLufs: -20, ceilingDb: -3, trimEdges: true, compress: false }

/** A finished narration: dialogue level, same ceiling as every dub line.
 * No compressor here either -- every chunk was already mastered to this
 * level on its own, so this pass only evens the seams; a compressor on
 * top audibly changes the voice's dynamics, and "sounds like me" beats
 * "perfectly even". */
export const NARRATION_LEVEL: VoiceLevelOptions = { targetLufs: -18, ceilingDb: -2, trimEdges: false, compress: false }

const TRIM_EDGES =
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,areverse'

/** Pass 1: clean and even the dynamics. Pure, unit-tested. */
export function buildVoiceShapeFilterGraph(options: Pick<VoiceLevelOptions, 'trimEdges' | 'compress'>): string {
  const steps: string[] = []
  // Rumble, handling noise and DC under the voice band.
  steps.push('highpass=f=70')
  if (options.trimEdges) steps.push(TRIM_EDGES)
  if (options.compress) steps.push('acompressor=threshold=-22dB:ratio=3:attack=10:release=150:knee=4')
  return steps.join(',')
}

/** Pass 2: the one measured gain onto target, peaks held at the ceiling. */
export function buildVoiceLevelFilterGraph(gainDb: number, ceilingDb: number): string {
  const limit = Math.pow(10, ceilingDb / 20).toFixed(4)
  return [`volume=${gainDb}dB`, `alimiter=limit=${limit}:attack=3:release=40:level=false`].join(',')
}

/** Renders the levelled clip to `outputPath` (16-bit PCM at `sampleRate`). */
export async function levelVoiceClip(jobId: string, inputPath: string, outputPath: string, options: VoiceLevelOptions, sampleRate = 48000): Promise<void> {
  const shapedPath = `${outputPath}.${jobId.replace(/[^A-Za-z0-9._-]+/g, '-')}.shaped.wav`
  try {
    // Float while it is still an intermediate; the levelled output below
    // is the 16-bit file that actually reaches the Timeline.
    await runFfmpeg(`${jobId}-shape`, ['-y', '-i', inputPath, '-af', buildVoiceShapeFilterGraph(options), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', shapedPath])
    const measured = await measureLineLoudness(shapedPath)
    const gainDb = computeMasterGainDb(measured, options.targetLufs, options.ceilingDb)
    const args = ['-y', '-i', shapedPath]
    if (options.maxSeconds) args.push('-t', String(options.maxSeconds))
    args.push('-af', buildVoiceLevelFilterGraph(gainDb, options.ceilingDb), '-c:a', 'pcm_s16le', outputPath)
    await runFfmpeg(`${jobId}-level`, args)
  } finally {
    await unlink(shapedPath).catch(() => undefined)
  }
}
