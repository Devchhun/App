import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpeg'
import { runFfmpeg } from './jobRunner'
import { probeMedia } from './probe'
import { unlink } from 'fs/promises'

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
export function computeMasterGainDb(measured: LineLoudness, targetLufs = DUB_TARGET_LUFS, ceilingDb = DUB_TRUE_PEAK_CEILING_DB, limiterAllowanceDb = 0): number {
  if (!Number.isFinite(measured.integratedLufs) || measured.integratedLufs < -70) return 0
  let gain = targetLufs - measured.integratedLufs
  // Peaks may go past the ceiling by `limiterAllowanceDb` -- the limiter in
  // buildMasterFilterGraph takes them back under it. Only loud performances
  // (a shout, an angry line) get an allowance: a shout is peaky, and without
  // this the ceiling alone held a shout BELOW its target (measured: -16.0
  // LUFS against a -13.1 target). Everything else keeps 0 -- the limiter as a
  // safety net that never has to act.
  const allowed = ceilingDb + Math.max(0, limiterAllowanceDb)
  if (Number.isFinite(measured.truePeakDb) && measured.truePeakDb + gain > allowed) gain = allowed - measured.truePeakDb
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(gain * 100) / 100))
}

const SPEECH_TRIM_FILTERS = [
  // Rumble/DC below the voice band -- nothing a speaking voice needs.
  'highpass=f=70',
  // Drop leading dead air but keep 30 ms so the first consonant isn't
  // clipped, so the line starts on its subtitle instead of after it.
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03',
  // And the dead air at the END (keeping 80 ms, so a word's last sound
  // rings out). Edge TTS puts ~1 s of silence after every line: a one-word
  // line was 0.2 s of speech in a 1.5 s file, so it counted as overrunning
  // its slot and the speech itself was sped up to fit -- the word came out
  // squashed and unclear.
  'areverse',
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08',
  'areverse'
]

/** Seconds of speech in a take: its length with the dead air before and
 * after trimmed exactly as masterDubbingLine trims it. The file's own
 * length when it cannot be measured. */
export async function measureSpeechSeconds(jobId: string, inputPath: string): Promise<number> {
  const trimmedPath = `${inputPath.replace(/\.[^./\\]+$/, '')}.speech.wav`
  try {
    await runFfmpeg(jobId, ['-y', '-i', inputPath, '-af', SPEECH_TRIM_FILTERS.join(','), trimmedPath])
    const { durationSeconds } = await probeMedia(trimmedPath)
    if (durationSeconds >= 0.1) return durationSeconds
  } catch {
    // Fall through to the untrimmed length.
  } finally {
    await unlink(trimmedPath).catch(() => {})
  }
  return (await probeMedia(inputPath)).durationSeconds
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
    ...SPEECH_TRIM_FILTERS,
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

/** A line's loudness: ffmpeg's loudnorm analyser, or -- for a line too
 * short for it (loudnorm's integrated loudness needs ~0.4 s; a one-word
 * line like "ឈប់!" is 0.3 s and came back as -inf) -- the line's RMS level,
 * which tracks LUFS within a dB or so on speech (measured -17.4 LUFS vs
 * -17.1 dB RMS). Without this the gain fell back to 0 and short words came
 * out ~8 dB quieter than every other line. */
export async function measureLineLoudness(inputPath: string): Promise<LineLoudness> {
  const measured = await measureLoudnorm(inputPath)
  if (Number.isFinite(measured.integratedLufs) && measured.integratedLufs >= -70) return measured
  const rmsDb = await measureRmsDb(inputPath)
  return rmsDb === null ? measured : { integratedLufs: rmsDb, truePeakDb: measured.truePeakDb }
}

/** The overall RMS level (dBFS) from ffmpeg's astats, or null. */
export function parseAstatsRmsDb(stderr: string): number | null {
  const overall = stderr.lastIndexOf('Overall')
  const match = /RMS level dB:\s*(-?[\d.]+)/.exec(overall >= 0 ? stderr.slice(overall) : stderr)
  const value = match ? parseFloat(match[1]) : NaN
  return Number.isFinite(value) && value > -90 ? value : null
}

function measureRmsDb(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', inputPath, '-af', 'astats=metadata=0', '-f', 'null', '-'])
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    proc.on('error', () => resolve(null))
    proc.on('close', () => resolve(parseAstatsRmsDb(stderr)))
  })
}

/** One decode pass through ffmpeg's loudnorm analyser. */
function measureLoudnorm(inputPath: string): Promise<LineLoudness> {
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
 * doesn't play.
 *
 * `targetLufs` is the line's own level: a performance line is brought to
 * its emotion's loudness (shared/dubbingPerformance.ts's
 * lineLoudnessTargetLufs -- a whisper around -26, a shout around -13),
 * everything else to DUB_TARGET_LUFS as before. Levelling every line to
 * one target made a whisper exactly as loud as a shout. The true-peak
 * ceiling (and the limiter when needed) is the same for every line, so a
 * loud line is louder, never clipped. */
export async function masterDubbingLine(jobId: string, inputPath: string, options: { targetLufs?: number; limiterAllowanceDb?: number } = {}): Promise<string> {
  try {
    const measured = await measureLineLoudness(inputPath)
    const gainDb = computeMasterGainDb(measured, options.targetLufs ?? DUB_TARGET_LUFS, DUB_TRUE_PEAK_CEILING_DB, options.limiterAllowanceDb ?? 0)
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

/** The stretches of sound in a take (seconds), split wherever it falls
 * quiet (below -40 dB) for 0.3 s or more. */
export function measureSpeechSpans(inputPath: string): Promise<{ start: number; end: number }[]> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', inputPath, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'])
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', () => resolve([]))
    proc.on('close', () => {
      const durationMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)
      if (!durationMatch) return resolve([])
      const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
      const silences: { start: number; end: number }[] = []
      let open: number | null = null
      for (const line of stderr.split('\n')) {
        const start = /silence_start: ([\d.]+)/.exec(line)
        if (start) open = Number(start[1])
        const end = /silence_end: ([\d.]+)/.exec(line)
        if (end && open !== null) {
          silences.push({ start: open, end: Number(end[1]) })
          open = null
        }
      }
      if (open !== null) silences.push({ start: open, end: duration })
      const spans: { start: number; end: number }[] = []
      let t = 0
      for (const silence of silences) {
        if (silence.start > t + 0.02) spans.push({ start: t, end: silence.start })
        t = silence.end
      }
      if (duration > t + 0.02) spans.push({ start: t, end: duration })
      resolve(spans)
    })
  })
}

/** The first `seconds` of a take, the last 30 ms faded out. */
export async function cutTake(jobId: string, inputPath: string, outPath: string, seconds: number): Promise<void> {
  const fadeStart = Math.max(0, seconds - 0.03)
  await runFfmpeg(jobId, ['-y', '-i', inputPath, '-t', seconds.toFixed(3), '-af', `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.03`, outPath])
}
