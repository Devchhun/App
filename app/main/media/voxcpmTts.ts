import { existsSync } from 'fs'
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, delimiter, dirname } from 'path'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { app } from 'electron'
import { runFfmpeg } from './jobRunner'
import { getMediaCacheRoot } from './cache'
import { probeMedia } from './probe'
import { levelVoiceClip, REFERENCE_LEVEL } from './voiceLeveling'
import { DEFAULT_VOICE_TONE, type VoxCpmDevice, type DubbingGenerationGroup, type ReferenceClipQuality, type VoiceTone } from '@shared/dubbing'

/** VoxCPM2 has a hard ~8,192-token context ceiling shared between reference
 * audio, input text, and generated audio -- at the model's own rough
 * throughput, that caps a USABLE cloning reference clip at roughly this
 * many seconds. Architectural, not a setting -- a longer reference either
 * fails outright or silently degrades, so this is checked up front rather
 * than discovered as a confusing mid-generation failure. */
const MAX_REFERENCE_AUDIO_SECONDS = 18

/** How much of a reference clip is actually handed to the model for
 * cloning. Distinct from MAX_REFERENCE_AUDIO_SECONDS (the hard ceiling
 * beyond which the clone breaks): this is the length that clones BEST.
 * Measured on a user's own 17.9s recording, six different lines each,
 * scored by per-line pitch spread (a wandering speaker identity shows up as
 * a wide spread):
 *
 *   full 17.9s reference -> 35.9 Hz
 *   trimmed to 8s        -> 23.1 Hz
 *   trimmed to 5s        -> 109.7 Hz   (too little voice to clone from)
 *
 * 8s is also exactly what the user's own rvc_gui.py caps at
 * (--max-reference-seconds 8.0), and that tool holds a voice steady. A
 * longer clip spends more of VoxCPM2's shared context budget on the
 * reference and leaves the model a looser fix on the speaker, not a
 * tighter one. */
const REFERENCE_CLIP_SECONDS = 8

/** How hard the model is pushed to obey its conditioning -- the reference
 * clip and the voice lock -- and how many denoising steps it gets to do it
 * in. Shared by every invocation (batch, seeded runner, and the one-off
 * voice-design mint) so the reference clip is made under the same settings
 * the lines cloning it are made under.
 *
 * These were 2.0/10, the CLI's own defaults. Measured on six different Khmer
 * lines all cloning one reference, scored by median pitch per line (a
 * different sampled speaker shows up as a pitch jump):
 *
 *   cfg 2.0 / 10 steps -> 68.6 Hz spread   (one line at 211 Hz vs ~148 Hz)
 *   cfg 2.0 / 18 steps -> 63.0 Hz
 *   cfg 2.5 / 18 steps -> 58.4 Hz
 *   cfg 3.0 / 10 steps -> 48.0 Hz
 *   cfg 3.0 / 18 steps -> 22.1 Hz
 *
 * Both levers matter -- raising cfg alone only reached 48.
 *
 * Do NOT read that table as "higher cfg is always tighter". Repeating the
 * sweep against a DIFFERENT minted reference for the same voice gave 45.9 Hz
 * at cfg 3.0 but 114.9 Hz at 4.0 and 112.4 Hz at 5.0 -- pushing past the
 * 1.0-3.0 range VoxCPM2 documents as recommended made it dramatically worse,
 * not better. 3.0/18 is the setting that held up across both references.
 *
 * The bigger remaining variable is not this setting at all: it is WHICH
 * reference clip ensureVoiceReferenceClip happened to mint. The same voice,
 * same prompt, same cfg scored 22.1 Hz with one minted reference and 45.9 Hz
 * with another. Making that reliable means minting several candidates and
 * keeping the one that measurably clones best, rather than trusting the
 * first sample -- not done here. */
const VOXCPM_CFG_VALUE = '3.0'
const VOXCPM_INFERENCE_TIMESTEPS = '18'

/** The same two levers, offered to the user as three settings (Settings >
 * Voice Engine > Voice tone). 3.0 holds one speaker hardest -- which is
 * what the table above was chosen for -- but pushing a diffusion model
 * that hard is also what makes a voice sound processed; 2.0 is VoxCPM2's
 * own documented middle and sounds smoother. Steps stay at 18 throughout:
 * they only ever helped. */
const TONE_SETTINGS: Record<VoiceTone, { cfg: string; steps: string }> = {
  natural: { cfg: '2.0', steps: '18' },
  balanced: { cfg: '2.5', steps: '18' },
  locked: { cfg: VOXCPM_CFG_VALUE, steps: VOXCPM_INFERENCE_TIMESTEPS }
}

export function toneSettings(tone: VoiceTone = DEFAULT_VOICE_TONE): { cfg: string; steps: string } {
  return TONE_SETTINGS[tone] ?? TONE_SETTINGS[DEFAULT_VOICE_TONE]
}

export interface ValidateVoxCpmInstallResult {
  ok: boolean
  missing: string[]
}

function voxcpmPaths(installDir: string): { pythonExe: string; sourceSrc: string; modelDir: string } {
  return {
    pythonExe: join(installDir, 'voxcpm_runtime', 'python.exe'),
    sourceSrc: join(installDir, 'VoxCPM-main', 'src'),
    modelDir: join(installDir, 'models', 'openbmb__VoxCPM2')
  }
}

/** Same three required paths the portable GUI's own `_validate_install()`
 * (VoxCPM2_GUI.py) checks -- a python runtime, the real `voxcpm` source
 * package, and local model weights. Deliberately does not check for
 * ffmpeg.exe inside the install (this app already has its own bundled
 * ffmpeg via app/main/media/ffmpeg.ts, used for post-processing below). */
export function validateVoxCpmInstall(installDir: string): ValidateVoxCpmInstallResult {
  const p = voxcpmPaths(installDir)
  const missing: string[] = []
  if (!existsSync(p.pythonExe)) missing.push(p.pythonExe)
  if (!existsSync(p.sourceSrc)) missing.push(p.sourceSrc)
  if (!existsSync(p.modelDir)) missing.push(p.modelDir)
  return { ok: missing.length === 0, missing }
}

export interface ValidateReferenceAudioResult {
  ok: boolean
  durationSeconds: number
}

/** Checks a Custom Voice reference clip against VoxCPM2's own hard length
 * ceiling (see MAX_REFERENCE_AUDIO_SECONDS) before ever spawning a clone-mode
 * batch for it -- reuses probe.ts's existing probeMedia (the same ffprobe
 * wrapper the main import pipeline already uses), no new ffprobe code. */
export async function validateReferenceAudioDuration(path: string): Promise<ValidateReferenceAudioResult> {
  const { durationSeconds } = await probeMedia(path)
  return { ok: durationSeconds <= MAX_REFERENCE_AUDIO_SECONDS, durationSeconds }
}

/** Builds `python -m voxcpm batch ...`'s exact argument array -- pure and
 * independently testable.
 *
 * `--control` and `--reference-audio` are sent TOGETHER, which the CLI
 * allows: its validate_prompt_related_args() only rejects `--control`
 * alongside `--prompt-text`/`--prompt-file`, never alongside
 * `--reference-audio`, and cmd_batch feeds both into the same
 * `model.generate()` call (the control is prepended to each line as
 * `(control)text`, the reference goes in as `reference_wav_path`). They do
 * different jobs and both are needed: the reference pins WHO is speaking,
 * while the control is the only channel that can say "one speaker, don't
 * act out the dialogue" -- without it VoxCPM2 happily performs a subtitle
 * line in several character voices at once. */
export function buildBatchArgs(
  group: Pick<DubbingGenerationGroup, 'control' | 'referenceAudioPath' | 'promptText'>,
  installDir: string,
  device: VoxCpmDevice,
  inputFile: string,
  outputDir: string
): string[] {
  const p = voxcpmPaths(installDir)
  // `voxcpm` has no __main__.py -- "python -m voxcpm ..." fails outright
  // ("'voxcpm' is a package and cannot be directly executed"). Confirmed by
  // running both forms directly against the user's own portable install:
  // `-m voxcpm.cli` (cli.py's own `if __name__ == "__main__":` guard) is the
  // real entry point and works correctly.
  const args = ['-m', 'voxcpm.cli', 'batch', '--input', inputFile, '--output-dir', outputDir]
  if (group.referenceAudioPath) {
    // `--prompt-text` is reserved for the separate `--prompt-audio`
    // continuation mode, and the CLI's own validate_prompt_related_args()
    // rejects `--prompt-text` without `--prompt-audio` outright (confirmed
    // by running the real CLI). promptText is kept in DubbingGenerationGroup
    // purely as user-facing documentation of what the clip says, not sent.
    args.push('--reference-audio', group.referenceAudioPath)
  }
  if (group.control) {
    args.push('--control', group.control)
  }
  // --no-denoiser: the denoiser is a SEPARATE model (ZipEnhancer) loaded
  // alongside the 2B TTS one, and it only ever does anything for prompt/
  // reference speech enhancement, which this app never asks for. Loading it
  // anyway costs VRAM and RAM that a 6GB card with 8GB system memory does
  // not have to spare -- on that hardware it is the difference between
  // running and thrashing.
  args.push(
    '--model-path',
    p.modelDir,
    '--device',
    device,
    '--local-files-only',
    '--no-denoiser',
    '--cfg-value',
    VOXCPM_CFG_VALUE,
    '--inference-timesteps',
    VOXCPM_INFERENCE_TIMESTEPS
  )
  return args
}

/** Where the seeded batch runner lives -- shipped as an extraResource in
 * packaged builds (see electron-builder.yml's python-worker entry), read
 * straight from the checkout in dev. */
export function voxcpmRunnerPath(): string {
  return pythonWorkerScript('voxcpm_batch_runner.py')
}

function pythonWorkerScript(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'python-worker', name) : join(__dirname, `../../python-worker/${name}`)
}

/** Speaker-similarity floor a cloned line must reach against its reference
 * before the runner tries the line again with another seed, and how many
 * extra tries it gets. Same-speaker pairs measure 0.85+, different
 * speakers ~0.65 (resemblyzer d-vectors on this app's own output); retries
 * only ever cost time on lines that came out under the floor, and the kept
 * take is always the closest one, so a line can never come out worse than
 * it would have without the check. */
export const VOICE_MATCH_THRESHOLD = '0.80'
export const VOICE_MATCH_RETRIES = '2'

/** Pitch match. The clearest sign the model sampled a different speaker
 * is a different baseline pitch (measured: 148 Hz on one line, 211 Hz --
 * six semitones -- on the next, same voice). A take whose median pitch
 * sits further than this from the reference clip's counts as the wrong
 * voice and is retried like a low-similarity one (see the runner). */
export const VOICE_PITCH_TOLERANCE_SEMITONES = '2'
/** What is left after the retries is nudged onto the reference's baseline
 * with a formant-preserving shift -- a uniform shift keeps every rise and
 * fall inside the take, only the speaker's baseline moves. Beyond this
 * the shift itself starts to sound processed (and a take that far off is
 * usually another speaker, which no shift turns back into the right one),
 * so larger drifts are left as they are -- the retry already picked the
 * closest take. Under half a semitone
 * nobody can hear it, so nothing is done. */
export const PITCH_CORRECTION_MAX_SEMITONES = 2
export const PITCH_CORRECTION_MIN_SEMITONES = 0.5

/** The semitone shift that puts a take measured `semitonesFromReference`
 * away back onto the reference baseline -- 0 when it's close enough
 * already, or so far off that shifting would do more harm than good. */
export function computePitchCorrection(semitonesFromReference: number): number {
  if (!Number.isFinite(semitonesFromReference)) return 0
  const drift = Math.abs(semitonesFromReference)
  if (drift < PITCH_CORRECTION_MIN_SEMITONES || drift > PITCH_CORRECTION_MAX_SEMITONES) return 0
  return Math.round(-semitonesFromReference * 100) / 100
}

/** Reads the `.pitch.json` the runner leaves beside a generated line (see
 * voxcpm_batch_runner.py) and turns it into the correction to apply. 0
 * when there is no sidecar (Edge TTS, the stock CLI, no reference). */
export async function readPitchCorrection(generatedPath: string): Promise<number> {
  const sidecar = generatedPath.replace(/\.wav$/i, '.pitch.json')
  if (sidecar === generatedPath || !existsSync(sidecar)) return 0
  try {
    const parsed = JSON.parse(await readFile(sidecar, 'utf-8')) as { semitones?: number }
    return computePitchCorrection(Number(parsed.semitones))
  } catch {
    return 0
  }
}

function runtimePython(installDir: string): string {
  return voxcpmPaths(installDir).pythonExe
}

function runPythonJson(pythonExe: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    let stdout = ''
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', () => undefined)
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
  })
}

/** The speaker encoder both the runner's match check and the clip-quality
 * measurement use. Installed into the VoxCPM2 runtime on first use, exactly
 * the way vocalRemoval.ts installs demucs there -- it's the one Python on
 * the machine with torch. Best-effort: false just means no match check and
 * no quality verdict, never a failed generation. */
export async function ensureVoiceMatcherInstalled(installDir: string): Promise<boolean> {
  const py = runtimePython(installDir)
  if (!existsSync(py)) return false
  try {
    const probe = await runPythonJson(py, ['-c', 'import resemblyzer'], 60_000)
    if (probe.code === 0) return true
    const install = await runPythonJson(py, ['-m', 'pip', 'install', '--quiet', 'resemblyzer'], 10 * 60_000)
    return install.code === 0
  } catch {
    return false
  }
}

/** Measures a prepared reference clip -- see python-worker/
 * voice_clip_quality.py. null when it can't be measured on this machine. */
export async function measureReferenceClipQuality(installDir: string, clipPath: string): Promise<ReferenceClipQuality | null> {
  const py = runtimePython(installDir)
  if (!existsSync(py) || !(await ensureVoiceMatcherInstalled(installDir))) return null
  try {
    const { stdout } = await runPythonJson(py, [pythonWorkerScript('voice_clip_quality.py'), clipPath], 3 * 60_000)
    const line = stdout.trim().split('\n').pop() ?? ''
    const parsed = JSON.parse(line) as { ok: boolean; consistency?: number; clippedRatio?: number; speechRatio?: number }
    if (!parsed.ok || typeof parsed.consistency !== 'number') return null
    return { consistency: parsed.consistency, clippedRatio: parsed.clippedRatio ?? 0, speechRatio: parsed.speechRatio ?? 1 }
  } catch {
    return null
  }
}

/** A voice's fixed RNG seed. Derived from the voice id alone, so it is the
 * same number on every machine and every run -- which, with the runner
 * re-seeding before each line, is what makes one voice reproduce the same
 * speaker identity every time. Verified against the real model: two runs at
 * the same seed produce byte-identical audio, two runs at different seeds
 * produce different speakers. Same derivation the user's own rvc_gui.py uses
 * (sha1 of the voice name, folded into a bounded positive int). */
export function voiceSeedFor(voiceId: string): number {
  const digest = createHash('sha1').update(`creative-ai-editor-voxcpm2-voice::${voiceId.trim().toLowerCase()}`).digest('hex')
  return 1000 + (parseInt(digest.slice(0, 8), 16) % 900000)
}

/** Builds the seeded runner's argument array -- pure and independently
 * testable. Mirrors buildBatchArgs's own flags, minus the ones the runner
 * doesn't need (it always runs local-files-only against an explicit model
 * path) and plus the `--seed` the stock CLI has no way to accept. */
export function buildSeededBatchArgs(
  group: Pick<DubbingGenerationGroup, 'voiceId' | 'control' | 'referenceAudioPath'>,
  installDir: string,
  device: VoxCpmDevice,
  inputFile: string,
  outputDir: string,
  options: { pitchMatch?: boolean; tone?: VoiceTone } = {}
): string[] {
  const tone = toneSettings(options.tone)
  const p = voxcpmPaths(installDir)
  const args = [
    voxcpmRunnerPath(),
    '--input',
    inputFile,
    '--output-dir',
    outputDir,
    '--model-path',
    p.modelDir,
    '--seed',
    String(voiceSeedFor(group.voiceId)),
    '--device',
    device,
    '--cfg-value',
    tone.cfg,
    '--inference-timesteps',
    tone.steps
  ]
  if (group.referenceAudioPath) {
    args.push('--reference-audio', group.referenceAudioPath)
    // Only meaningful with a reference to match against; the runner itself
    // skips the check when its encoder isn't importable.
    args.push('--match-threshold', VOICE_MATCH_THRESHOLD, '--match-retries', VOICE_MATCH_RETRIES)
    // Off: no tolerance flag, so the runner never measures pitch and writes
    // no .pitch.json -- readPitchCorrection then finds nothing to apply.
    if (options.pitchMatch !== false) args.push('--pitch-tolerance', VOICE_PITCH_TOLERANCE_SEMITONES)
  }
  if (group.control) args.push('--control', group.control)
  return args
}

/** The line spoken into a voice's one-off reference clip. Never reaches the
 * user's project -- the clip exists only to FIX a timbre, and is then fed
 * back in as `--reference-audio` for every real line of that voice. Khmer,
 * because that's what these voices go on to dub and a reference in the
 * target language clones more faithfully than one in another. */
const VOICE_DESIGN_SEED_TEXT = 'សួស្តី ខ្ញុំនិយាយភាសាខ្មែរ ដើម្បីធ្វើជាគំរូសម្លេង។'

/** Builds `voxcpm.cli design ...`'s exact argument array -- pure and
 * independently testable. `design` is VoxCPM2's own "invent a voice from a
 * text description" mode; unlike `batch` it writes exactly one file, which
 * is what makes it usable for minting a reference clip. */
export function buildVoiceDesignArgs(control: string, installDir: string, device: VoxCpmDevice, outputPath: string): string[] {
  const p = voxcpmPaths(installDir)
  return [
    '-m',
    'voxcpm.cli',
    'design',
    '--text',
    VOICE_DESIGN_SEED_TEXT,
    '--control',
    control,
    '--output',
    outputPath,
    '--model-path',
    p.modelDir,
    '--device',
    device,
    '--local-files-only',
    // Same reason as buildBatchArgs -- nothing here enhances a reference.
    '--no-denoiser',
    '--cfg-value',
    VOXCPM_CFG_VALUE,
    '--inference-timesteps',
    VOXCPM_INFERENCE_TIMESTEPS
  ]
}

/** Where a voice's minted reference clip lives. Keyed by a hash of the voice
 * id AND its control text, so editing a voice's description mints a fresh
 * one instead of silently reusing the old timbre, while an unchanged voice
 * keeps the exact same file -- and therefore the exact same voice -- across
 * every future Generate, not just within one run. */
export function voiceReferenceClipPath(voiceId: string, control: string): string {
  const hash = createHash('sha1').update(`${voiceId} ${control}`).digest('hex').slice(0, 16)
  return join(getMediaCacheRoot(), 'voice-refs', `${voiceId}-${hash}.wav`)
}

/** VoxCPM2 has no seed option (confirmed by reading its own cli.py: there is
 * no --seed anywhere, and no torch.manual_seed call). In `--control` mode it
 * SAMPLES a speaker from its prior for each utterance, so a batch of 200
 * subtitles all set to one voice comes out as 200 subtly different people --
 * which is exactly the "why does one character keep changing voice" this
 * fixes. Cloning is the only deterministic path the CLI offers, so a voice's
 * timbre is minted ONCE here (via `design`) and every real line is then
 * generated with `--reference-audio` pointed at that clip.
 *
 * Best-effort by design: any failure returns null and the caller falls back
 * to plain `--control`, i.e. exactly today's behavior. Minting is never
 * allowed to be the thing that breaks dubbing outright. */
export async function ensureVoiceReferenceClip(installDir: string, device: VoxCpmDevice, voiceId: string, control: string): Promise<string | null> {
  const outputPath = voiceReferenceClipPath(voiceId, control)
  if (existsSync(outputPath)) return outputPath

  const p = voxcpmPaths(installDir)
  await mkdir(dirname(outputPath), { recursive: true })
  const args = buildVoiceDesignArgs(control, installDir, device, outputPath)
  const env = { ...process.env, PYTHONPATH: [p.sourceSrc, process.env.PYTHONPATH].filter(Boolean).join(delimiter) }

  return new Promise<string | null>((resolve) => {
    const proc = spawn(p.pythonExe, args, { env })
    let stallTimer: ReturnType<typeof setTimeout>
    const armStall = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => proc.kill(), STALL_TIMEOUT_MS)
    }
    armStall()
    proc.stdout.on('data', armStall)
    proc.stderr.on('data', armStall)
    proc.on('error', () => {
      clearTimeout(stallTimer)
      resolve(null)
    })
    proc.on('close', () => {
      clearTimeout(stallTimer)
      resolve(existsSync(outputPath) ? outputPath : null)
    })
  })
}

export interface RunVoxCpmBatchResult {
  /** Same order as the input `texts` -- null for a line that never produced
   * a usable output file (VoxCPM2 logs "Failed on line N" for these but
   * keeps processing the rest; see cli.py's own cmd_batch). */
  outputPaths: (string | null)[]
}

function batchOutputPath(outputDir: string, index: number): string {
  return join(outputDir, `output_${String(index + 1).padStart(3, '0')}.wav`)
}

/** No VoxCPM2 process should run silently forever, but a real diffusion TTS
 * model paying a one-time load cost (reading a 2B-parameter checkpoint) before
 * its first line completes needs much more slack than ffmpeg's own 90s
 * stall timeout (jobRunner.ts) -- reset on every stdout/stderr byte, so a
 * merely SLOW batch (long line, CPU fallback, big model) is never killed,
 * only one that's gone completely silent for this long. */
const STALL_TIMEOUT_MS = 5 * 60_000

/** Runs one `voxcpm batch` invocation for one voice group -- the model loads
 * ONCE and generates every line in `texts` in order, instead of paying that
 * load cost per subtitle (see this feature's own plan for why grouping by
 * voice, not one call per line, is the whole point). Progress is driven by
 * VoxCPM2's own per-line stderr output (`Saved: ...`/`Failed on line N: ...`,
 * confirmed by reading cli.py's cmd_batch directly), which processes lines
 * strictly in file order -- `onSegmentDone(index, outputPath)` fires
 * immediately as EACH line finishes (checking that line's own
 * deterministically-named `output_NNN.wav` right then, `null` if it's
 * missing/that line failed), not just once at the very end -- this is what
 * lets the caller start post-processing and handing a line to the Timeline
 * the moment it's ready, rather than waiting for the whole voice group's
 * batch to finish before the user sees anything land. The final resolved
 * result re-checks every path the same way, as a consistency backstop. */
export function runVoxCpmBatch(
  jobId: string,
  installDir: string,
  device: VoxCpmDevice,
  group: Pick<DubbingGenerationGroup, 'voiceId' | 'control' | 'referenceAudioPath' | 'promptText'>,
  texts: string[],
  onSegmentDone: (index: number, outputPath: string | null) => void,
  options: { pitchMatch?: boolean; tone?: VoiceTone; signal?: AbortSignal } = {}
): Promise<RunVoxCpmBatchResult> {
  const p = voxcpmPaths(installDir)

  return mkdtemp(join(tmpdir(), 'voxcpm-')).then((workDir) => {
    const inputFile = join(workDir, 'input.txt')
    const outputDir = join(workDir, 'out')
    return writeFile(inputFile, texts.join('\n'), 'utf-8').then(
      () =>
        new Promise<RunVoxCpmBatchResult>((resolve, reject) => {
          // Prefer the seeded runner: it re-seeds every RNG before each line,
          // which is the only thing that makes VoxCPM2's speaker sampling
          // reproducible (its own CLI has no --seed at all). Measured against
          // the real model: same seed -> byte-identical audio, different seed
          // -> a different speaker. The runner deliberately mimics
          // cmd_batch's output naming and stderr protocol, so everything
          // below parses it identically -- and if it's somehow missing from
          // the install, the stock CLI still runs, just without the seed.
          const runnerPath = voxcpmRunnerPath()
          const args = existsSync(runnerPath)
            ? buildSeededBatchArgs(group, installDir, device, inputFile, outputDir, options)
            : buildBatchArgs(group, installDir, device, inputFile, outputDir)
          const env = { ...process.env, PYTHONPATH: [p.sourceSrc, process.env.PYTHONPATH].filter(Boolean).join(delimiter) }
          const proc = spawn(p.pythonExe, args, { env })
          // Cancel stops the model mid-batch; lines already saved are kept
          // (the close handler below still resolves with them).
          if (options.signal?.aborted) proc.kill()
          options.signal?.addEventListener('abort', () => proc.kill(), { once: true })

          let completed = 0
          let stderrTail = ''
          let stallTimer: ReturnType<typeof setTimeout>
          const armStall = (): void => {
            clearTimeout(stallTimer)
            stallTimer = setTimeout(() => proc.kill(), STALL_TIMEOUT_MS)
          }
          armStall()

          const handleStderr = (chunk: Buffer): void => {
            armStall()
            stderrTail += chunk.toString()
            const lines = stderrTail.split('\n')
            stderrTail = lines.pop() ?? ''
            for (const line of lines) {
              if (/^Saved: /.test(line) || /^Failed on line \d+:/.test(line)) {
                const index = Math.min(completed, texts.length - 1)
                completed = Math.min(completed + 1, texts.length)
                const path = batchOutputPath(outputDir, index)
                onSegmentDone(index, existsSync(path) ? path : null)
              }
            }
          }
          proc.stderr.on('data', handleStderr)
          proc.stdout.on('data', () => armStall())

          proc.on('error', (err) => {
            clearTimeout(stallTimer)
            reject(err)
          })

          proc.on('close', (code) => {
            clearTimeout(stallTimer)
            const outputPaths = texts.map((_, i) => {
              const path = batchOutputPath(outputDir, i)
              return existsSync(path) ? path : null
            })
            if (outputPaths.every((path) => path === null)) {
              reject(new Error(`VoxCPM2 batch produced no output (exit code ${code})`))
              return
            }
            resolve({ outputPaths })
          })
        })
    )
  })
}

/** How much a generated line needs to speed up to fit its subtitle's own
 * time slot -- 1 (no change) when it already fits. Clamped to a MAX of
 * 1.28x even when the overrun is larger, matching the reference pipeline's
 * own ceiling for "protect a minimum intelligible duration": past that
 * point the clip is deliberately left running long (may overlap the next
 * segment's own dub clip) rather than sped up into unintelligibility or,
 * worse, cut off mid-word -- see this feature's own plan for why overlap is
 * the honest failure mode here, not truncation. Pure and independently
 * testable; the actual speed-up is applied by composing this into the
 * existing buildDubbingPostFxFilterGraph/applyDubbingPostFx below, not a
 * separate filter step. */
export function computeAutoFitSpeed(generatedDurationSeconds: number, slotDurationSeconds: number): number {
  if (slotDurationSeconds <= 0 || generatedDurationSeconds <= slotDurationSeconds) return 1
  const MAX_AUTO_FIT_SPEED = 1.28
  return Math.min(MAX_AUTO_FIT_SPEED, generatedDurationSeconds / slotDurationSeconds)
}

/** Combines only the requested (non-neutral) steps into one ffmpeg filter
 * graph -- returns null when pitch/speed/volume are all at their neutral
 * defaults (0/1/0), matching narrationAudio.ts's buildNarrationFilterGraph
 * "no-op when nothing enabled" precedent exactly, so a plain-default segment
 * never pays an extra ffmpeg pass.
 *
 * Pitch and speed both go through ONE `rubberband` filter (confirmed present
 * in this app's own bundled ffmpeg -- `librubberband` is compiled in) rather
 * than the classic asetrate+atempo chain this used to use. Two real problems
 * with that chain, not just a style preference: (1) it hardcoded a 44100Hz
 * base sample rate for the pitch step's asetrate/aresample pair, but
 * VoxCPM2's real output is 48000Hz (confirmed by probing an actual generated
 * file) -- a silent, wrong-rate assumption baked into the filter string
 * itself. (2) atempo's native range is only 0.5-2.0, so any ratio outside
 * that (including nearly every auto-fit-speed value produced by
 * computeAutoFitSpeed above, which routinely lands beteen 1.0-1.28) had to
 * be split across two chained atempo stages -- fine mathematically, but
 * atempo's own WSOLA-style stretching is known to introduce audible warble/
 * jitter, worse when chained, which is exactly what was reported ("choppy,
 * not smooth") once dubbed audio could finally be heard cleanly (see the
 * video-mute fix just before this). `rubberband` handles the full 0.01-100
 * tempo/pitch range in one pass with much higher-fidelity time-stretching,
 * and `formant=preserved` keeps a pitch-shifted voice sounding like a human
 * voice instead of a sped-up/slowed-down tape ("chipmunk" effect). */
export function buildDubbingPostFxFilterGraph(fx: { pitch: number; speed: number; volumeDb: number }): string | null {
  const steps: string[] = []

  const pitchRatio = Math.pow(2, fx.pitch / 12)
  const speed = Math.max(0.25, Math.min(4, fx.speed))
  if (pitchRatio !== 1 || speed !== 1) {
    const params = [`tempo=${speed}`]
    // `pitchq=quality` costs a little time and nothing in sound. The
    // music-oriented extras (transients=smooth, smoothing=on, a short
    // window) were measured on this app's own generated speech and all
    // made it WORSE -- harmonic clarity fell from 17.6 dB to 16.6 dB --
    // so they are deliberately not set.
    if (pitchRatio !== 1) params.push(`pitch=${pitchRatio}`, 'formant=preserved', 'pitchq=quality')
    steps.push(`rubberband=${params.join(':')}`)
  }

  if (fx.volumeDb !== 0) steps.push(`volume=${fx.volumeDb}dB`)

  return steps.length > 0 ? steps.join(',') : null
}

/** Applies pitch/speed/volume (none of which are native VoxCPM2 generation
 * params) to one generated line, via this app's own already-bundled ffmpeg
 * (app/main/media/jobRunner.ts's runFfmpeg -- the SAME helper every other
 * ffmpeg-writing step in this codebase uses). Returns `wavPath` UNCHANGED
 * (no ffmpeg spawned at all) when every value is neutral. A generated line
 * is never trimmed to fit its slot -- see AiDubberContext.tsx's
 * tryDrainPlacementQueue for how an overrunning line is handled instead
 * (the next line's placement is delayed, not this line's content cut). */
/** Converts anything the user hands Custom Voice -- a browser MediaRecorder
 * .webm from the in-app recorder, an .mp3/.m4a they picked off disk -- into
 * the one shape VoxCPM2 can actually read as a cloning reference: 16-bit
 * mono PCM wav at 24kHz.
 *
 * Necessary because the model side reads reference audio through Python's
 * `soundfile` (libsndfile), which has no webm/opus or mp4/aac support at
 * all. Handing it the recorder's raw output fails inside the model process,
 * where the only symptom the user ever sees is a line that didn't generate.
 * Also trims to MAX_REFERENCE_AUDIO_SECONDS, since a longer clip blows
 * VoxCPM2's shared context budget (see that constant's own doc comment).
 *
 * Written into the same `generated` media cache the rest of this feature
 * uses, so it survives restarts and is picked up by the project's own
 * cleanup like any other generated asset. */
export async function prepareReferenceClip(jobId: string, sourcePath: string, options: { level?: boolean } = {}): Promise<string> {
  const outDir = join(getMediaCacheRoot(), 'voice-refs')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, `custom-${jobId}.wav`)
  if (options.level) {
    // "Even voice": decode the whole take first, then level it (edges
    // trimmed, dynamics evened, peaks held) and cut it to clone length --
    // see voiceLeveling.ts. Trimming before the cut means the 8 s kept is
    // speech, not the silence before the first word.
    const rawPath = join(outDir, `custom-${jobId}.raw.wav`)
    try {
      await runFfmpeg(`${jobId}-decode`, ['-y', '-i', sourcePath, '-t', '60', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', rawPath])
      await levelVoiceClip(jobId, rawPath, outPath, { ...REFERENCE_LEVEL, maxSeconds: REFERENCE_CLIP_SECONDS }, 24000)
    } finally {
      await unlink(rawPath).catch(() => undefined)
    }
    return outPath
  }
  await runFfmpeg(jobId, [
    '-y',
    '-i',
    sourcePath,
    '-t',
    String(REFERENCE_CLIP_SECONDS),
    '-ac',
    '1',
    '-ar',
    '24000',
    '-c:a',
    'pcm_s16le',
    outPath
  ])
  return outPath
}

/** Returns a reference clip no longer than REFERENCE_CLIP_SECONDS -- the
 * same path back if it already is, otherwise a trimmed copy cached beside
 * the other voice references (keyed by the source path, so it's made once).
 * Lets every voice saved or picked BEFORE the 8s finding benefit from it
 * without being re-recorded. Best-effort: if probing or trimming fails the
 * original is used, exactly as before. */
export async function ensureReferenceCloneLength(sourcePath: string): Promise<string> {
  try {
    const { durationSeconds } = await probeMedia(sourcePath)
    if (durationSeconds <= REFERENCE_CLIP_SECONDS + 0.05) return sourcePath
    const outDir = join(getMediaCacheRoot(), 'voice-refs')
    await mkdir(outDir, { recursive: true })
    const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 16)
    const outPath = join(outDir, `trim${REFERENCE_CLIP_SECONDS}-${hash}.wav`)
    if (existsSync(outPath)) return outPath
    await runFfmpeg(`ref-trim-${hash}`, ['-y', '-i', sourcePath, '-t', String(REFERENCE_CLIP_SECONDS), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', outPath])
    return existsSync(outPath) ? outPath : sourcePath
  } catch {
    return sourcePath
  }
}

/** Everything but letters, digits, dot, dash and underscore becomes a dash. */
export function fileNameSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-')
}

export async function applyDubbingPostFx(jobId: string, inputPath: string, fx: { pitch: number; speed: number; volumeDb: number }): Promise<string> {
  const filterGraph = buildDubbingPostFxFilterGraph(fx)
  if (!filterGraph) return inputPath
  // Always writes .wav regardless of what came in -- VoxCPM2 produces .wav,
  // Edge TTS produces .mp3, and re-encoding a filtered result to lossy mp3
  // would throw away quality for no reason.
  // The job id goes into the file name, so it must be file-name safe: a
  // saved voice's id ("saved:abc") carries a colon, which on Windows turns
  // "name.dub-batch-saved:abc.fx.wav" into an NTFS alternate data stream
  // of a file called "name.dub-batch-saved" -- unplayable, unimportable.
  const outPath = `${inputPath.replace(/\.[^./\\]+$/, '')}.${fileNameSafe(jobId)}.fx.wav`
  // Float intermediate (see dubbingMaster.ts's own note).
  await runFfmpeg(jobId, ['-y', '-i', inputPath, '-af', filterGraph, '-c:a', 'pcm_f32le', outPath])
  return outPath
}
