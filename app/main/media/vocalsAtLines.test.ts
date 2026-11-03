import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const FFMPEG = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg.exe')
const dir = mkdtempSync(join(tmpdir(), 'at-lines-test-'))

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))
vi.mock('./ffmpeg', () => ({ ffmpegPath: join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg.exe'), ffprobePath: '' }))
vi.mock('./cache', () => ({ cacheKeyForFile: async () => 'key', ensureCacheDir: async () => dir }))
vi.mock('./probe', () => ({ probeMedia: async () => ({ durationSeconds: 3 }), probeAudioChannels: async () => 2 }))

const tone = (name: string, hz: number, seconds = 3): string => {
  const path = join(dir, name)
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${hz}:d=${seconds}:r=48000`, '-ac', '2', '-c:a', 'pcm_s16le', path])
  return path
}

/** How much of each tone is in one stretch of a file (mean of the two
 * correlations with a sine at that pitch). */
const strengthAt = (path: string, start: number, end: number, hz: number): number => {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(start), '-t', String(end - start), '-i', path, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 })
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2))
  let re = 0
  let im = 0
  samples.forEach((s, i) => {
    re += s * Math.cos((2 * Math.PI * hz * i) / 48000)
    im += s * Math.sin((2 * Math.PI * hz * i) / 48000)
  })
  return Math.hypot(re, im) / samples.length
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('mixVocalsAtLines', () => {
  it('keeps the original outside the lines and the voice-free sound over them', async () => {
    const { mixVocalsAtLines } = await import('./vocalsAtLines')
    const out = await mixVocalsAtLines(tone('source.wav', 440), tone('clean.wav', 880), [{ start: 1, end: 2 }])
    expect(existsSync(out)).toBe(true)
    expect(out).toMatch(/no-vocals-at-lines-[0-9a-f]+\.m4a$/)
    expect(strengthAt(out, 0.2, 0.8, 440)).toBeGreaterThan(10 * strengthAt(out, 0.2, 0.8, 880))
    expect(strengthAt(out, 1.2, 1.8, 880)).toBeGreaterThan(10 * strengthAt(out, 1.2, 1.8, 440))
    expect(strengthAt(out, 2.2, 2.8, 440)).toBeGreaterThan(10 * strengthAt(out, 2.2, 2.8, 880))
  }, 60000)

  it('stops at the given length when the video sound runs longer than it', async () => {
    const { mixVocalsAtLines } = await import('./vocalsAtLines')
    const out = await mixVocalsAtLines(tone('long.wav', 440, 5), tone('clean3.wav', 880, 3), [{ start: 1, end: 2 }])
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 })
    expect(raw.length / 2 / 48000).toBeGreaterThan(2.9)
    expect(raw.length / 2 / 48000).toBeLessThan(3.2)
  }, 60000)

  it('reports a separated sound that cannot be read, and leaves no half-made file', async () => {
    const { mixVocalsAtLines } = await import('./vocalsAtLines')
    await expect(mixVocalsAtLines(tone('source4.wav', 440), join(dir, 'gone.m4a'), [{ start: 1, end: 2 }])).rejects.toThrow(/separated sound/)
    expect(readdirSync(dir).some((name) => name.includes('.tmp.'))).toBe(false)
  }, 30000)

  it('reports a video that cannot be read, instead of waiting for ever', async () => {
    const { mixVocalsAtLines } = await import('./vocalsAtLines')
    await expect(mixVocalsAtLines(join(dir, 'gone.mp4'), tone('clean2.wav', 880), [{ start: 1, end: 2 }])).rejects.toThrow(/Could not read the sound/)
  }, 30000)
})
