import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpeg'
import { runFfmpeg } from './jobRunner'
import { probeMedia } from './probe'

/** Makes every generated dub line sit at the same level and start/stop
 * cleanly, so a scene doesn't lurch between a shouted line and a whispered
 * one and no line lands with a click.
 *
 * Measured on a real project's generated lines before this existed: the
 * quietest and loudest line were 13.4 LU apart (-20.9 vs -7.6 LUFS -- one
 * character's lines came out at roughly a quarter of another's volume), 24
 * of 31 lines peaked at or above -1 dBTP with several past 0 dBTP (audible
 * distortion on a clipped reference recording's clones), and every line
 * ended in a hard cut with up to 0.2 s of dead air at the front (the line
 * starting late against its subtitle).
 *
 * The fix is deliberately LINEAR: one measured gain per line, not a
 * dynamic loudness processor -- on a 1-4 s line the dynamic kind pumps and
 * flattens the very expression the voice was cloned for. The limiter is a
 * safety net for overshoot, not the leveler. */

/** Dialogue level every line is brought to. -18 LUFS leaves room for the
 * original music bed underneath and matches typical broadcast dialogue. */
export const DUB_TARGET_LUFS = -18
/** Where peaks are held. Rubberband speed-fitting afterwards can add a
 * little overshoot, so this sits comfortably under -1 dBTP. */
export const DUB_TRUE_PEAK_CEILING_DB = -2
/** Hard bounds on the correction so a mis-measured (near-silent, or all
 * noise) line can't be blown up into a roar or crushed to nothing. */
const MAX_GAIN_DB = 18
const MIN_GAIN_DB = -18

export interface LineLoudness {
  integratedLufs: number
  truePeakDb: number
}

/** The one static gain that puts the line on target without its peaks
 * crossing the ceiling. Pure, so the arithmetic is unit-tested. */
export function computeMasterGainDb(measured: LineLoudness, targetLufs = DUB_TARGET_LUFS, ceilingDb = DUB_TRUE_PEAK_CEILING_DB): number {
  if (!Number.isFinite(measured.integratedLufs) || measured.integratedLufs < -70) return 0
  let gain = targetLufs - measured.integratedLufs
  if (Number.isFinite(measured.truePeakDb) && measured.truePeakDb + gain > ceilingDb) gain = ceilingDb - measured.truePeakDb
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(gain * 100) / 100))
}

/** ffmpeg filter chain for one line, given its measured gain. Order
 * matters: trim the dead air first so fades land on speech, level, then
 * limit, then shape the edges, then pad so the fade-out has somewhere to
 * go instead of being the last sample. */
export function buildMasterFilterGraph(gainDb: number, ceilingDb = DUB_TRUE_PEAK_CEILING_DB, measured?: LineLoudness): string {
  const limit = Math.pow(10, ceilingDb / 20).toFixed(4)
  // The gain above is already chosen so the measured true peak lands under
  // the ceiling, so the limiter is a safety net -- and a safety net that
  // never has to act is one that can never pump or fizz on a voice. It is
  // left out entirely whenever the peak after gain is known to be clear.
  const peakAfterGain = measured && Number.isFinite(measured.truePeakDb) ? measured.truePeakDb + gainDb : Number.POSITIVE_INFINITY
  const needsLimiter = !(peakAfterGain <= ceilingDb - 0.1)
  return [
    // Rumble/DC below the voice band -- nothing a speaking voice needs.
    'highpass=f=70',
    // Drop leading dead air but keep 30 ms so the first consonant isn't
    // clipped, so the line starts on its subtitle instead of after it.
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03',
    `volume=${gainDb}dB`,
    ...(needsLimiter ? [`alimiter=limit=${limit}:attack=3:release=40:level=false`] : []),
    'afade=t=in:d=0.01',
    // 50 ms of room at the end, then a 30 ms fade-out across it (afade
    // out needs the total length, which we don't have; reversing twice
    // fades the tail without it).
    'apad=pad_dur=0.05',
    'areverse',
    'afade=t=in:d=0.03',
    'areverse'
  ].join(',')
}

/** One decode pass through ffmpeg's loudnorm analyser. */
export function measureLineLoudness(inputPath: string): Promise<LineLoudness> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', inputPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'])
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    proc.on('error', reject)
    proc.on('close', () => {
      const parsed = parseLoudnormJson(stderr)
      if (!parsed) {
        reject(new Error('ffmpeg produced no loudness measurement'))
        return
      }
      resolve(parsed)
    })
  })
}

export function parseLoudnormJson(stderr: string): LineLoudness | null {
  const match = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr)
  if (!match) return null
  try {
    const json = JSON.parse(match[0]) as { input_i?: string; input_tp?: string }
    return { integratedLufs: parseFloat(json.input_i ?? 'NaN'), truePeakDb: parseFloat(json.input_tp ?? 'NaN') }
  } catch {
    return null
  }
}

/** Measures, then renders the leveled/cleaned line beside the input as
 * `<name>.master.wav`. Falls back to the untouched input if measuring or
 * rendering fails -- a line that plays at its raw level beats a line that
 * doesn't play. */
export async function masterDubbingLine(jobId: string, inputPath: string): Promise<string> {
  try {
    const measured = await measureLineLoudness(inputPath)
    const gainDb = computeMasterGainDb(measured)
    const outPath = `${inputPath.replace(/\.[^./\\]+$/, '')}.master.wav`
    // 32-bit float, not 16-bit: this file is an INTERMEDIATE -- speed-fit,
    // pitch match, stitching and levelling all still come. Re-quantising to
    // 16 bits at every one of those stages is what adds the fizzy, bubbling
    // edge to a quiet synthesized voice; only the file the user finally
    // gets is written as 16-bit PCM.
    await runFfmpeg(jobId, ['-y', '-i', inputPath, '-af', buildMasterFilterGraph(gainDb, DUB_TRUE_PEAK_CEILING_DB, measured), '-c:a', 'pcm_f32le', outPath])
    // A line the model rendered as (near) silence would come out of
    // silenceremove as nothing at all -- keep the original so the failure
    // stays visible as a silent clip rather than a zero-length one that
    // breaks the speed-fit downstream.
    const { durationSeconds } = await probeMedia(outPath)
    return durationSeconds >= 0.1 ? outPath : inputPath
  } catch {
    return inputPath
  }
}
