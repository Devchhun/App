import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { keepTempMedia } from './dubAudioStore'

describe('keepTempMedia', () => {
  it('copies a temp-folder file into the kept folder, reuses that copy once the temp one is gone, and leaves other paths alone', async () => {
    const base = await mkdtemp(join(tmpdir(), 'keep-temp-test-'))
    const temp = join(base, 'Temp')
    const root = join(base, 'dub-audio')
    await mkdir(join(temp, 'edge-tts-abc'), { recursive: true })
    const line = join(temp, 'edge-tts-abc', 'kiri-1.master.wav')
    await writeFile(line, 'voice')

    const kept = await keepTempMedia(line, root, temp)
    expect(kept).toBe(join(root, 'edge-tts-abc', 'kiri-1.master.wav'))
    expect(await readFile(kept, 'utf8')).toBe('voice')

    // The copy wins from now on, whether or not the temp file survives.
    expect(await keepTempMedia(line, root, temp)).toBe(kept)
    // Gone from both places: unchanged (the media shows as missing).
    const lost = join(temp, 'edge-tts-abc', 'kiri-2.master.wav')
    expect(await keepTempMedia(lost, root, temp)).toBe(lost)
    // Not in the temp folder at all.
    const elsewhere = join(base, 'Videos', 'ep1.mp4')
    expect(await keepTempMedia(elsewhere, root, temp)).toBe(elsewhere)
  })
})
