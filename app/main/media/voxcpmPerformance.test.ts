import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))

import { buildRunnerJobsJsonl, computeExcessPitchCorrection, parseRunnerDebugLine, performanceSeedFor, readPitchCorrection, voiceSeedFor } from './voxcpmTts'
import { buildMasterFilterGraph, computeMasterGainDb, DUB_TRUE_PEAK_CEILING_DB } from './dubbingMaster'
import { buildLineControl, emotionProfile, lineLimiterAllowanceDb, lineLoudnessTargetLufs, neutralPerformance, type LinePerformance } from '@shared/dubbingPerformance'

const perf = (emotion: LinePerformance['emotion'], intensity: number): LinePerformance => ({ ...neutralPerformance('ai'), emotion, emotionIntensity: intensity })

describe('performance seed', () => {
  it('keeps the voice seed as its base and stays stable for the same line and take', () => {
    const base = voiceSeedFor('male-adult')
    const seed = performanceSeedFor('male-adult', 'srt-12', 0)
    expect(seed).toBe(performanceSeedFor('male-adult', 'srt-12', 0))
    expect(seed).toBeGreaterThan(base)
    expect(seed).toBeLessThanOrEqual(base + 97_331)
  })
  it('differs per line, so lines do not share one delivery pattern', () => {
    const seeds = new Set(['srt-1', 'srt-2', 'srt-3', 'srt-4', 'srt-5'].map((id) => performanceSeedFor('male-adult', id)))
    expect(seeds.size).toBe(5)
  })
  it('differs per take, so Regenerate gives a different performance', () => {
    expect(performanceSeedFor('male-adult', 'srt-12', 1)).not.toBe(performanceSeedFor('male-adult', 'srt-12', 0))
  })
  it('never reaches the runner retry step (base + 1,000,003)', () => {
    for (const voice of ['male-adult', 'female-old', 'saved:abc']) {
      for (let i = 0; i < 50; i++) expect(performanceSeedFor(voice, `l${i}`, i % 3) - voiceSeedFor(voice)).toBeLessThan(1_000_003)
    }
  })
})

describe('runner jobs (what reaches voxcpm_batch_runner.py)', () => {
  it('writes one JSON object per line with its own control, seed, profile and slot', () => {
    const angry = perf('angry', 85)
    const control = buildLineControl('adult male Khmer voice', angry)
    const jsonl = buildRunnerJobsJsonl(['ឯងកុហក!', 'plain'], [{ control, seed: 12345, profile: emotionProfile(angry), slotSeconds: 2.456 }, {}])
    const [first, second] = jsonl.split('\n').map((l) => JSON.parse(l))
    expect(first.text).toBe('ឯងកុហក!')
    expect(first.control).toBe(control)
    expect(first.control).not.toMatch(/perform dialogue/i)
    expect(first.seed).toBe(12345)
    expect(first.profile.pitchToleranceSemitones).toBe(4)
    expect(first.profile.pitchCorrect).toBe(false)
    expect(first.slotSeconds).toBe(2.46)
    // A line with no performance falls back to the group's control and seed.
    expect(second).toEqual({ text: 'plain' })
  })
  it('sends "no control" as an empty control, not the group default', () => {
    expect(JSON.parse(buildRunnerJobsJsonl(['x'], [{ control: null }])).control).toBe('')
  })
})

describe('runner debug report', () => {
  it('parses the kept take into the line debug record', () => {
    const parsed = parseRunnerDebugLine(
      'Debug: {"attempt": 2, "seed": 1797377, "similarity": 0.884, "pitchDriftSt": 5.66, "pitchShiftSt": 5.66, "pitchVariationSt": 4.7, "energyVariationDb": 6.2, "expression": 1.0, "naturalness": 1.0, "timing": 1.0, "score": 0.93, "flat": false, "reasons": [], "line": 3, "attempts": 2, "control": "Keep exactly..."}'
    )
    expect(parsed?.index).toBe(2)
    expect(parsed?.debug).toMatchObject({ attempt: 2, attempts: 2, seed: 1797377, similarity: 0.884, pitchDriftSt: 5.66, expressiveness: 1, score: 0.93, flat: false, control: 'Keep exactly...' })
  })
  it('ignores every other stderr line', () => {
    expect(parseRunnerDebugLine('Saved: out.wav (2.1s)')).toBeNull()
    expect(parseRunnerDebugLine('Debug: not json')).toBeNull()
  })
})

describe('pitch correction respects the emotion', () => {
  it('pulls an expressive take back only by what exceeds its limit', () => {
    expect(computeExcessPitchCorrection(3.2, 4)).toBe(0)
    expect(computeExcessPitchCorrection(5.5, 4)).toBe(-1.5)
    expect(computeExcessPitchCorrection(-5, 3.5)).toBe(1.5)
    expect(computeExcessPitchCorrection(12, 4)).toBe(-3)
    expect(computeExcessPitchCorrection(6, null)).toBe(0)
  })
  it('reads the limit from the runner sidecar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pitch-cap-'))
    try {
      const shout = join(dir, 'output_003.wav')
      await writeFile(shout.replace('.wav', '.pitch.json'), JSON.stringify({ semitones: 6.1, correct: false, cap: 4.5 }))
      expect(await readPitchCorrection(shout)).toBe(-1.6)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('applies to a neutral take and never to one the runner marked expressive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pitch-sidecar-'))
    try {
      const neutral = join(dir, 'output_001.wav')
      const angry = join(dir, 'output_002.wav')
      await writeFile(neutral.replace('.wav', '.pitch.json'), JSON.stringify({ semitones: 1.5, correct: true }))
      await writeFile(angry.replace('.wav', '.pitch.json'), JSON.stringify({ semitones: 1.5, correct: false }))
      expect(await readPitchCorrection(neutral)).toBe(-1.5)
      expect(await readPitchCorrection(angry)).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('emotion-aware loudness (masterDubbingLine gain)', () => {
  it('does not bring a whisper and a shout to the same level', () => {
    // The same raw take measured at -20 LUFS / -10 dBTP.
    const measured = { integratedLufs: -20, truePeakDb: -10 }
    const whisperGain = computeMasterGainDb(measured, lineLoudnessTargetLufs(perf('whisper', 75)))
    const neutralGain = computeMasterGainDb(measured, lineLoudnessTargetLufs(perf('neutral', 30)))
    const shoutGain = computeMasterGainDb(measured, lineLoudnessTargetLufs(perf('shout', 90)))
    expect(whisperGain).toBeLessThan(neutralGain)
    expect(shoutGain).toBeGreaterThan(neutralGain)
    // Apart, but inside the 8 dB that keeps an episode even over music.
    expect(shoutGain - whisperGain).toBeGreaterThanOrEqual(5)
    expect(shoutGain - whisperGain).toBeLessThanOrEqual(8)
  })
  it('lets a peaky shout reach its level through the limiter (measured: it stopped at -16 LUFS without)', () => {
    // A real shouted take: -17 LUFS integrated, peaks at -2.9 dBTP.
    const shoutTake = { integratedLufs: -17, truePeakDb: -2.9 }
    const shout = perf('shout', 95)
    const withoutLimiter = computeMasterGainDb(shoutTake, lineLoudnessTargetLufs(shout))
    const withLimiter = computeMasterGainDb(shoutTake, lineLoudnessTargetLufs(shout), DUB_TRUE_PEAK_CEILING_DB, lineLimiterAllowanceDb(shout))
    expect(withLimiter).toBeGreaterThan(withoutLimiter)
    // ...and the limiter is then in the chain, holding the ceiling.
    expect(buildMasterFilterGraph(withLimiter, DUB_TRUE_PEAK_CEILING_DB, shoutTake)).toContain('alimiter=limit=')
  })
  it('gives no limiter allowance to quiet or neutral lines', () => {
    expect(lineLimiterAllowanceDb(perf('whisper', 90))).toBe(0)
    expect(lineLimiterAllowanceDb(perf('neutral', 30))).toBe(0)
    expect(lineLimiterAllowanceDb(undefined)).toBe(0)
  })
  it('still protects a shout from clipping (true-peak ceiling)', () => {
    const hot = { integratedLufs: -16, truePeakDb: -3 }
    const gain = computeMasterGainDb(hot, lineLoudnessTargetLufs(perf('shout', 100)))
    expect(-3 + gain).toBeLessThanOrEqual(-2)
  })
})
