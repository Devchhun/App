import { mkdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { runFfmpeg } from './jobRunner'
import { getMediaCacheRoot } from './cache'
import { levelVoiceClip, NARRATION_LEVEL } from './voiceLeveling'

/** Pulls the read together so it flows as one voice: drops the dead air
 * the model leaves before the first word and after the last, and shortens
 * every pause inside a take (sentence ends, breaths) to a ~0.10 s beat --
 * just enough for the words not to run into each other. Measured:
 * silences of 0.6-1.4 s all come out at 0.10 s (the residual is roughly
 * stop_duration + stop_silence + the detection window). */
const TIGHTEN_PAUSES =
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03:stop_periods=-1:stop_duration=0.05:stop_threshold=-45dB:stop_silence=0.03'

/** Every cut the line above makes is a splice, and a splice in the middle
 * of a breath is a click. `adeclick` repairs exactly that kind of one-off
 * discontinuity, and leaves ordinary speech alone. */
const DECLICK = 'adeclick=window=55:overlap=75:arorder=2:threshold=2'

/** How many files one ffmpeg call may join. Windows caps a command line at
 * ~32,000 characters, and each input costs `-i <full path>`: a 250-part
 * recap blew straight past it and the spawn failed with ENAMETOOLONG
 * ("The generated parts could not be joined into one file"). Parts are
 * therefore joined in passes -- 40 at a time, then the results of those
 * joined the same way -- which keeps every command line short no matter
 * how long the script is (40 -> 1,600 -> 64,000 parts). */
export const MAX_INPUTS_PER_PASS = 40

/** Splits `items` into runs of at most `size`. Pure, so the pass planning
 * is testable without touching ffmpeg. */
export function chunkForPasses<T>(items: T[], size = MAX_INPUTS_PER_PASS): T[][] {
  if (items.length <= size) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One ffmpeg join: normalise each input, insert the silence between
 * neighbours, concat. `tighten` is off for a pass over files an earlier
 * pass already tightened -- the pause trimming and declicking must happen
 * once per take, not once per pass. */
async function joinPass(
  jobId: string,
  inputPaths: string[],
  gapSeconds: number,
  outPath: string,
  options: { tighten: boolean; float: boolean }
): Promise<void> {
  const args: string[] = ['-y']
  for (const p of inputPaths) args.push('-i', p)
  const parts: string[] = []
  const labels: string[] = []
  const perInput = options.tighten ? `${TIGHTEN_PAUSES},${DECLICK},` : ''
  inputPaths.forEach((_p, i) => {
    parts.push(`[${i}:a]${perInput}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a${i}]`)
    labels.push(`[a${i}]`)
    if (i < inputPaths.length - 1 && gapSeconds > 0) {
      parts.push(`anullsrc=r=48000:cl=mono,atrim=0:${gapSeconds.toFixed(3)},aformat=sample_fmts=fltp[g${i}]`)
      labels.push(`[g${i}]`)
    }
  })
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`)
  // The graph goes in a file rather than on the command line: it grows with
  // the input count too, and this keeps the spawn well clear of the limit.
  const scriptPath = `${outPath}.filter.txt`
  await writeFile(scriptPath, parts.join(';\n'))
  args.push('-filter_complex_script', scriptPath, '-map', '[out]', '-c:a', options.float ? 'pcm_f32le' : 'pcm_s16le', outPath)
  try {
    await runFfmpeg(jobId, args)
  } finally {
    await unlink(scriptPath).catch(() => undefined)
  }
}

/** Joins `inputPaths` end to end into one mono 48k WAV, with `gapSeconds`
 * of silence between neighbours -- a recap narration is one continuous
 * read, not a row of separate clips. Any number of parts: see
 * MAX_INPUTS_PER_PASS for how long scripts are joined in passes. */
export async function stitchAudio(
  jobId: string,
  inputPaths: string[],
  gapSeconds: number,
  options: { level?: boolean; fileName?: string } = {}
): Promise<string> {
  const fileName = options.fileName ?? 'Recap narration.wav'
  if (inputPaths.length === 0) throw new Error('Nothing to stitch.')
  // Its own folder per run so the file can carry a readable name (that
  // name is what the Media panel and the Timeline clip show).
  const dir = join(getMediaCacheRoot(), 'generated', `${Date.now()}-${jobId}`)
  await mkdir(dir, { recursive: true })
  const outPath = join(dir, fileName)
  // With leveling, the joined file is rendered beside the final name and
  // then evened as a whole (see voiceLeveling.ts) -- one gain for the
  // whole read, so no paragraph comes out louder than its neighbours.
  const joinedPath = options.level ? join(dir, 'joined.wav') : outPath

  const temps: string[] = []
  try {
    let current = inputPaths
    let tighten = true
    let pass = 0
    // Fold the list down until one pass can take what is left.
    while (current.length > MAX_INPUTS_PER_PASS) {
      const groups = chunkForPasses(current)
      const next: string[] = []
      for (let i = 0; i < groups.length; i++) {
        const partPath = join(dir, `pass${pass}-${String(i).padStart(3, '0')}.wav`)
        // Float between passes: a recap can go through three of them, and
        // re-quantising to 16 bits each time is what adds a fizzy edge.
        await joinPass(`${jobId}-p${pass}-${i}`, groups[i], gapSeconds, partPath, { tighten, float: true })
        temps.push(partPath)
        next.push(partPath)
      }
      current = next
      // Whatever came out of a pass is already tightened and declicked.
      tighten = false
      pass++
    }
    await joinPass(jobId, current, gapSeconds, joinedPath, { tighten, float: !!options.level })

    if (options.level) {
      await levelVoiceClip(`${jobId}-level`, joinedPath, outPath, NARRATION_LEVEL)
      await unlink(joinedPath).catch(() => undefined)
    }
  } finally {
    for (const temp of temps) await unlink(temp).catch(() => undefined)
  }

  // Leave a sidecar listing the sources -- handy when a stitched file
  // needs tracing back to its lines.
  await writeFile(`${outPath}.sources.txt`, inputPaths.join('\n')).catch(() => undefined)
  return outPath
}
