import { describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { emotionProfile, neutralPerformance, type LinePerformance } from '@shared/dubbingPerformance'

/** Runs python-worker/test_voxcpm_scoring.py (the runner's emotion-aware
 * scoring) with the app's bundled Python, handing it the profiles the REAL
 * TypeScript emotionProfile() produces -- so the runner is tested against
 * exactly what the main process sends it. Skipped only when this checkout
 * has no bundled Python (scripts/fetch-portable-python.ps1 not run). */
const root = resolve(__dirname, '../../..')
const python = join(root, 'resources', 'python-runtime', 'python.exe')
const script = join(root, 'python-worker', 'test_voxcpm_scoring.py')
const perf = (emotion: LinePerformance['emotion'], intensity: number): LinePerformance => ({ ...neutralPerformance('ai'), emotion, emotionIntensity: intensity })

describe.skipIf(!existsSync(python))('VoxCPM2 runner: emotion-aware retry scoring', () => {
  it('passes every scoring case with the TypeScript profiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-scoring-'))
    try {
      const profiles = {
        neutral: emotionProfile(perf('neutral', 30)),
        calm: emotionProfile(perf('calm', 40)),
        angry: emotionProfile(perf('angry', 85)),
        angry_mild: emotionProfile(perf('angry', 40)),
        shout: emotionProfile(perf('shout', 90)),
        crying: emotionProfile(perf('crying', 85)),
        shocked: emotionProfile(perf('shocked', 78)),
        whisper: emotionProfile(perf('whisper', 75))
      }
      const file = join(dir, 'profiles.json')
      await writeFile(file, JSON.stringify(profiles), 'utf-8')
      const run = spawnSync(python, [script, file], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      const output = `${run.stdout}\n${run.stderr}`
      expect(output, output).toMatch(/\nOK\s*$/)
      expect(run.status).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
