import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
// voiceReferenceClipPath resolves the cache root through electron's `app`,
// which doesn't exist outside the real main process -- same stub
// edgeTts.test.ts uses for the same reason.
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))

import { validateVoxCpmInstall, buildBatchArgs, buildDubbingPostFxFilterGraph, INNER_VOICE_ECHO_FILTER, computeAutoFitSpeed, buildVoiceDesignArgs, voiceReferenceClipPath, voiceSeedFor, buildSeededBatchArgs, VOICE_MATCH_THRESHOLD, VOICE_MATCH_RETRIES, VOICE_PITCH_TOLERANCE_SEMITONES, computePitchCorrection, fileNameSafe, toneSettings } from './voxcpmTts'

describe('validateVoxCpmInstall', () => {
  let installDir: string

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'voxcpm-install-test-'))
  })

  afterEach(async () => {
    await rm(installDir, { recursive: true, force: true })
  })

  async function makeCompleteInstall(dir: string): Promise<void> {
    await mkdir(join(dir, 'voxcpm_runtime'), { recursive: true })
    await writeFile(join(dir, 'voxcpm_runtime', 'python.exe'), '')
    await mkdir(join(dir, 'VoxCPM-main', 'src'), { recursive: true })
    await mkdir(join(dir, 'models', 'openbmb__VoxCPM2'), { recursive: true })
  }

  it('reports ok with no missing paths for a complete install', async () => {
    await makeCompleteInstall(installDir)
    expect(validateVoxCpmInstall(installDir)).toEqual({ ok: true, missing: [] })
  })

  it('reports every missing required path for an empty directory', () => {
    const result = validateVoxCpmInstall(installDir)
    expect(result.ok).toBe(false)
    expect(result.missing).toHaveLength(3)
  })

  it('reports ok:false with just the one missing path when only the model weights are absent', async () => {
    await mkdir(join(installDir, 'voxcpm_runtime'), { recursive: true })
    await writeFile(join(installDir, 'voxcpm_runtime', 'python.exe'), '')
    await mkdir(join(installDir, 'VoxCPM-main', 'src'), { recursive: true })

    const result = validateVoxCpmInstall(installDir)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([join(installDir, 'models', 'openbmb__VoxCPM2')])
  })
})

describe('buildBatchArgs', () => {
  const installDir = 'C:\\VoxCPM2'
  const inputFile = 'C:\\tmp\\input.txt'
  const outputDir = 'C:\\tmp\\out'

  it('uses --control for a voice-design group', () => {
    const args = buildBatchArgs({ control: 'warm female voice' }, installDir, 'auto', inputFile, outputDir)
    expect(args).toContain('--control')
    expect(args[args.indexOf('--control') + 1]).toBe('warm female voice')
    expect(args).not.toContain('--reference-audio')
  })

  it('uses --reference-audio (never --prompt-text -- the CLI rejects it without --prompt-audio) for a cloning group that carries no control', () => {
    const args = buildBatchArgs({ referenceAudioPath: 'C:\\ref.wav', promptText: 'hello there' }, installDir, 'cuda', inputFile, outputDir)
    expect(args).toContain('--reference-audio')
    expect(args[args.indexOf('--reference-audio') + 1]).toBe('C:\\ref.wav')
    expect(args).not.toContain('--prompt-text')
    expect(args).not.toContain('--control')
  })

  // The CLI allows both together (its validate_prompt_related_args only bars
  // --control alongside --prompt-text), and cmd_batch feeds each into a
  // different argument of the same model.generate() call. Both are needed:
  // the reference clip pins WHO speaks, the control is the only place that
  // can say "one speaker, don't act out the dialogue".
  it('sends the control lock ALONGSIDE the cloned reference, not instead of it', () => {
    const args = buildBatchArgs(
      { control: 'STRICT VOICE LOCK: use exactly Male Adult.', referenceAudioPath: 'C:\\ref.wav', promptText: 'hi' },
      installDir,
      'auto',
      inputFile,
      outputDir
    )
    expect(args[args.indexOf('--reference-audio') + 1]).toBe('C:\\ref.wav')
    expect(args[args.indexOf('--control') + 1]).toBe('STRICT VOICE LOCK: use exactly Male Adult.')
    // Still never --prompt-text: that one genuinely is rejected without --prompt-audio.
    expect(args).not.toContain('--prompt-text')
  })

  it('always includes --model-path, --device, and --local-files-only', () => {
    const args = buildBatchArgs({ control: 'x' }, installDir, 'cpu', inputFile, outputDir)
    expect(args).toContain('--model-path')
    expect(args[args.indexOf('--model-path') + 1]).toBe(join(installDir, 'models', 'openbmb__VoxCPM2'))
    expect(args).toContain('--device')
    expect(args[args.indexOf('--device') + 1]).toBe('cpu')
    expect(args).toContain('--local-files-only')
  })
})

describe('buildDubbingPostFxFilterGraph', () => {
  it('returns null when pitch/speed/volume are all neutral', () => {
    expect(buildDubbingPostFxFilterGraph({ pitch: 0, speed: 1, volumeDb: 0 })).toBeNull()
  })

  it('adds the inner-voice echo last, after the speed-fit, only when asked', () => {
    expect(buildDubbingPostFxFilterGraph({ pitch: 0, speed: 1, volumeDb: 0, echo: true })).toBe(INNER_VOICE_ECHO_FILTER)
    const graph = buildDubbingPostFxFilterGraph({ pitch: 0, speed: 1.2, volumeDb: 2, echo: true })!
    expect(graph.endsWith(INNER_VOICE_ECHO_FILTER)).toBe(true)
    expect(graph.indexOf('rubberband')).toBeLessThan(graph.indexOf('aecho'))
    expect(buildDubbingPostFxFilterGraph({ pitch: 0, speed: 1.2, volumeDb: 0, echo: false })).not.toContain('aecho')
  })

  it('builds a rubberband filter with formant preservation for a non-zero pitch shift', () => {
    const graph = buildDubbingPostFxFilterGraph({ pitch: 12, speed: 1, volumeDb: 0 })
    expect(graph).toBe('rubberband=tempo=1:pitch=2:formant=preserved:pitchq=quality')
  })

  it('builds a plain rubberband tempo filter for a speed change, no chaining needed', () => {
    const graph = buildDubbingPostFxFilterGraph({ pitch: 0, speed: 1.5, volumeDb: 0 })
    expect(graph).toBe('rubberband=tempo=1.5')
  })

  it('handles a speed ratio above ffmpeg atempo\'s old 2x ceiling in one filter, no chaining', () => {
    const graph = buildDubbingPostFxFilterGraph({ pitch: 0, speed: 3, volumeDb: 0 })
    expect(graph).toBe('rubberband=tempo=3')
  })

  it('handles a speed ratio below ffmpeg atempo\'s old 0.5x floor in one filter, no chaining', () => {
    const graph = buildDubbingPostFxFilterGraph({ pitch: 0, speed: 0.25, volumeDb: 0 })
    expect(graph).toBe('rubberband=tempo=0.25')
  })

  it('appends a volume filter for a non-zero dB adjustment', () => {
    const graph = buildDubbingPostFxFilterGraph({ pitch: 0, speed: 1, volumeDb: 6 })
    expect(graph).toBe('volume=6dB')
  })

  it('combines pitch and speed into one rubberband call, with volume as a separate trailing step', () => {
    const graph = buildDubbingPostFxFilterGraph({ pitch: 12, speed: 1.5, volumeDb: -3 })
    expect(graph).toBe('rubberband=tempo=1.5:pitch=2:formant=preserved:pitchq=quality,volume=-3dB')
  })
})

describe('computeAutoFitSpeed', () => {
  it('returns 1 (no change) when the generated clip already fits its slot', () => {
    expect(computeAutoFitSpeed(3, 5)).toBe(1)
  })

  it('returns 1 when the generated clip exactly matches its slot', () => {
    expect(computeAutoFitSpeed(5, 5)).toBe(1)
  })

  it('speeds up by the exact overrun ratio when that stays within the 1.28x ceiling', () => {
    expect(computeAutoFitSpeed(6, 5)).toBeCloseTo(1.2, 5)
  })

  it('clamps to 1.28x when the overrun would need more than that', () => {
    expect(computeAutoFitSpeed(10, 5)).toBe(1.28)
  })

  it('never divides by zero or goes negative for a degenerate zero-length slot', () => {
    expect(computeAutoFitSpeed(3, 0)).toBe(1)
  })
})

describe('buildVoiceDesignArgs', () => {
  const INSTALL = 'C:\VoxCPM2'

  it('uses the `design` subcommand, which writes exactly one file', () => {
    const args = buildVoiceDesignArgs('a calm older man', INSTALL, 'cuda', 'C:\out\ref.wav')
    expect(args.slice(0, 3)).toEqual(['-m', 'voxcpm.cli', 'design'])
  })

  it('passes the voice description through as --control', () => {
    const args = buildVoiceDesignArgs('a bright young woman', INSTALL, 'cuda', 'C:\out\ref.wav')
    expect(args[args.indexOf('--control') + 1]).toBe('a bright young woman')
  })

  it('writes to the exact output path it was given', () => {
    const args = buildVoiceDesignArgs('narrator', INSTALL, 'cpu', 'C:\out\ref.wav')
    expect(args[args.indexOf('--output') + 1]).toBe('C:\out\ref.wav')
  })

  it('runs fully offline against the local model, like every other call', () => {
    const args = buildVoiceDesignArgs('narrator', INSTALL, 'cpu', 'C:\out\ref.wav')
    expect(args).toContain('--local-files-only')
    expect(args[args.indexOf('--device') + 1]).toBe('cpu')
    expect(args[args.indexOf('--model-path') + 1]).toBe(join(INSTALL, 'models', 'openbmb__VoxCPM2'))
  })

  it('never passes --reference-audio -- this call is what CREATES the reference', () => {
    const args = buildVoiceDesignArgs('narrator', INSTALL, 'cuda', 'C:\out\ref.wav')
    expect(args).not.toContain('--reference-audio')
  })
})

describe('voiceReferenceClipPath', () => {
  it('is stable for the same voice, so re-generating re-uses the same timbre', () => {
    expect(voiceReferenceClipPath('male-adult', 'a calm man')).toBe(voiceReferenceClipPath('male-adult', 'a calm man'))
  })

  it('changes when the voice description changes, so an edited voice is re-minted', () => {
    expect(voiceReferenceClipPath('male-adult', 'a calm man')).not.toBe(voiceReferenceClipPath('male-adult', 'an angry man'))
  })

  it('keeps two different voices apart even if described identically', () => {
    expect(voiceReferenceClipPath('male-adult', 'a person')).not.toBe(voiceReferenceClipPath('male-elder', 'a person'))
  })

  it('names the file after the voice, so the cache is readable on disk', () => {
    expect(voiceReferenceClipPath('female-adult', 'x')).toMatch(/female-adult-[0-9a-f]{16}\.wav$/)
  })
})

describe('voiceSeedFor', () => {
  it('is stable for a voice -- the same voice gets the same speaker every run', () => {
    expect(voiceSeedFor('male-adult')).toBe(voiceSeedFor('male-adult'))
  })

  it('differs between voices, so two characters do not collide on one speaker', () => {
    expect(voiceSeedFor('male-adult')).not.toBe(voiceSeedFor('female-adult'))
    expect(voiceSeedFor('male-adult')).not.toBe(voiceSeedFor('male-old'))
  })

  it('ignores case and surrounding whitespace', () => {
    expect(voiceSeedFor('  Male-Adult  ')).toBe(voiceSeedFor('male-adult'))
  })

  it('stays a positive, bounded integer the CLI can accept', () => {
    for (const id of ['male-adult', 'female-old', 'khmer-narrator', 'anime-girl', 'movie-hero']) {
      const seed = voiceSeedFor(id)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(1000)
      expect(seed).toBeLessThan(901000)
    }
  })
})

describe('buildSeededBatchArgs', () => {
  const INSTALL = 'C:\VoxCPM2'

  it("passes the voice's own fixed seed", () => {
    const args = buildSeededBatchArgs({ voiceId: 'male-adult', control: 'x' }, INSTALL, 'cuda', 'in.txt', 'out')
    expect(args[args.indexOf('--seed') + 1]).toBe(String(voiceSeedFor('male-adult')))
  })

  it('sends the reference clip and the voice lock together, same as the CLI path', () => {
    const args = buildSeededBatchArgs(
      { voiceId: 'male-adult', control: 'STRICT VOICE LOCK: use exactly Male Adult.', referenceAudioPath: 'C:\ref.wav' },
      INSTALL,
      'cuda',
      'in.txt',
      'out'
    )
    expect(args[args.indexOf('--reference-audio') + 1]).toBe('C:\ref.wav')
    expect(args[args.indexOf('--control') + 1]).toBe('STRICT VOICE LOCK: use exactly Male Adult.')
  })

  it('asks the runner to verify each line against the reference speaker, with retries', () => {
    const args = buildSeededBatchArgs({ voiceId: 'saved:abc', referenceAudioPath: 'C:\ref.wav' }, INSTALL, 'cuda', 'in.txt', 'out')
    expect(args[args.indexOf('--match-threshold') + 1]).toBe(VOICE_MATCH_THRESHOLD)
    expect(args[args.indexOf('--match-retries') + 1]).toBe(VOICE_MATCH_RETRIES)
    expect(args[args.indexOf('--pitch-tolerance') + 1]).toBe(VOICE_PITCH_TOLERANCE_SEMITONES)
    expect(buildSeededBatchArgs({ voiceId: 'saved:abc', referenceAudioPath: 'C:\ref.wav' }, INSTALL, 'cuda', 'in.txt', 'out', { pitchMatch: false })).not.toContain('--pitch-tolerance')
  })

  it('sends no match check without a reference -- there is nothing to match against', () => {
    const args = buildSeededBatchArgs({ voiceId: 'male-adult', control: 'x' }, INSTALL, 'cuda', 'in.txt', 'out')
    expect(args).not.toContain('--match-threshold')
    expect(args).not.toContain('--match-retries')
    expect(args).not.toContain('--pitch-tolerance')
  })

  it('runs the runner script itself, not `-m voxcpm.cli`', () => {
    const args = buildSeededBatchArgs({ voiceId: 'male-adult' }, INSTALL, 'cpu', 'in.txt', 'out')
    expect(args[0]).toMatch(/voxcpm_batch_runner\.py$/)
    expect(args).not.toContain('-m')
  })

  it('points at the same local model directory the CLI path uses', () => {
    const args = buildSeededBatchArgs({ voiceId: 'male-adult' }, INSTALL, 'cpu', 'in.txt', 'out')
    expect(args[args.indexOf('--model-path') + 1]).toBe(join(INSTALL, 'models', 'openbmb__VoxCPM2'))
    expect(args[args.indexOf('--device') + 1]).toBe('cpu')
  })
})

describe('computePitchCorrection', () => {
  it('shifts a take back onto the reference baseline by the measured drift', () => {
    expect(computePitchCorrection(1.8)).toBe(-1.8)
    expect(computePitchCorrection(-1.4)).toBe(1.4)
  })

  it('leaves an already-close take alone', () => {
    expect(computePitchCorrection(0.3)).toBe(0)
    expect(computePitchCorrection(-0.49)).toBe(0)
  })

  it('does not try to rescue a take that landed on another speaker', () => {
    // Six semitones is the measured 148 -> 211 Hz jump: shifting that far
    // sounds processed, and the retry already kept the closest attempt.
    expect(computePitchCorrection(2.6)).toBe(0)
    expect(computePitchCorrection(6.1)).toBe(0)
    expect(computePitchCorrection(NaN)).toBe(0)
  })
})

describe('fileNameSafe', () => {
  it('keeps a saved voice id from becoming an NTFS stream separator in a file name', () => {
    expect(fileNameSafe('dub-batch-saved:abc-123-1')).toBe('dub-batch-saved-abc-123-1')
    expect(fileNameSafe('custom-voice-1')).toBe('custom-voice-1')
  })
})

describe('voice tone', () => {
  it('maps each tone to the cfg value it was measured at, and falls back to balanced', () => {
    expect(toneSettings('natural')).toEqual({ cfg: '2.0', steps: '18' })
    expect(toneSettings('balanced')).toEqual({ cfg: '2.5', steps: '18' })
    expect(toneSettings('locked')).toEqual({ cfg: '3.0', steps: '18' })
    expect(toneSettings()).toEqual({ cfg: '2.5', steps: '18' })
  })

  it('sends the chosen tone to the runner', () => {
    const args = buildSeededBatchArgs({ voiceId: 'saved:abc', referenceAudioPath: 'C:\ref.wav' }, 'C:\VoxCPM2', 'cuda', 'in.txt', 'out', { tone: 'natural' })
    expect(args[args.indexOf('--cfg-value') + 1]).toBe('2.0')
  })
})
