import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// `isPackaged: false` makes getBundledPythonPath look for a dev-checkout
// runtime path that doesn't exist under the test's own __dirname, so these
// cases exercise the user-provided-install fallback -- the branch the
// installDir argument is actually for.
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))

const { validateEdgeTtsInstall, buildEdgeTtsArgs, edgeTtsOutputPath, hasSpeakableText, explainEdgeTtsFailure, runEdgeTtsLine } = await import('./edgeTts')

describe('validateEdgeTtsInstall', () => {
  let installDir: string

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'edge-tts-install-test-'))
  })

  afterEach(async () => {
    await rm(installDir, { recursive: true, force: true })
  })

  it('reports ok once the portable python runtime is present', async () => {
    await mkdir(join(installDir, 'voxcpm_runtime'), { recursive: true })
    await writeFile(join(installDir, 'voxcpm_runtime', 'python.exe'), '')
    expect(validateEdgeTtsInstall(installDir)).toEqual({ ok: true, missing: [] })
  })

  it('reports the missing python path for an empty directory', () => {
    const result = validateEdgeTtsInstall(installDir)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([join(installDir, 'voxcpm_runtime', 'python.exe')])
  })

  it('needs no model weights or source package, unlike VoxCPM2', async () => {
    await mkdir(join(installDir, 'voxcpm_runtime'), { recursive: true })
    await writeFile(join(installDir, 'voxcpm_runtime', 'python.exe'), '')
    expect(validateEdgeTtsInstall(installDir).ok).toBe(true)
  })
})

describe('buildEdgeTtsArgs', () => {
  it('runs the 96 kbps runner script when it is there', () => {
    const args = buildEdgeTtsArgs('km-KH-PisethNeural', 'សួស្តី', 'C:\\tmp\\line_0001.mp3', 'C:\\app\\python-worker\\edge_tts_runner.py')
    expect(args).toEqual(['C:\\app\\python-worker\\edge_tts_runner.py', '--voice', 'km-KH-PisethNeural', '--text', 'សួស្តី', '--write-media', 'C:\\tmp\\line_0001.mp3'])
  })

  it('falls back to the stock edge_tts module when the runner is missing', () => {
    const args = buildEdgeTtsArgs('km-KH-PisethNeural', 'សួស្តី', 'C:\\tmp\\line_0001.mp3', null)
    expect(args).toEqual(['-m', 'edge_tts', '--voice', 'km-KH-PisethNeural', '--text', 'សួស្តី', '--write-media', 'C:\\tmp\\line_0001.mp3'])
  })

  it('keeps text as a single argument even when it contains spaces and punctuation', () => {
    const args = buildEdgeTtsArgs('km-KH-SreymomNeural', 'ជំរាបសួរ, តើអ្នកសុខសប្បាយទេ?', '/tmp/a.mp3')
    expect(args[args.indexOf('--text') + 1]).toBe('ជំរាបសួរ, តើអ្នកសុខសប្បាយទេ?')
  })
})

describe('edgeTtsOutputPath', () => {
  it('names files in zero-padded line order so they sort correctly', () => {
    expect(edgeTtsOutputPath('C:\\work', 0)).toBe(join('C:\\work', 'line_0001.mp3'))
    expect(edgeTtsOutputPath('C:\\work', 41)).toBe(join('C:\\work', 'line_0042.mp3'))
  })
})

describe('lines with nothing to speak', () => {
  // Measured against the real service: each of these makes edge_tts exit 1
  // with NoAudioReceived; ordinary Khmer/English lines (even "-Wait!") work.
  it('recognises symbol-only lines', () => {
    for (const text of ['...', '♪♪', '—', '!?', '😢', '', '   ']) expect(hasSpeakableText(text)).toBe(false)
    for (const text of ['ហា ហា', 'Where are you going?', '-Wait for me!', '3']) expect(hasSpeakableText(text)).toBe(true)
  })

  it('stops at once when Cancel came before the line started', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runEdgeTtsLine('C:\\nowhere', 'km-KH-SreymomNeural', 'សួស្តី', 'C:\\nowhere\\x.mp3', controller.signal)).rejects.toThrow('Canceled')
  })

  it('refuses an untranslated Chinese line at once, with the real reason', async () => {
    await expect(runEdgeTtsLine('C:\\nowhere', 'km-KH-PisethNeural', '当然了我这三味真火', 'C:\\nowhere\\x.mp3')).rejects.toThrow(/still in Chinese.*Translate/)
  })

  it('refuses them without starting Python', async () => {
    await expect(runEdgeTtsLine('C:\\nowhere', 'km-KH-SreymomNeural', '♪♪', 'C:\\nowhere\\x.mp3')).rejects.toThrow('no words to speak')
  })
})

describe('explainEdgeTtsFailure', () => {
  // The shape of real edge_tts output: traceback first, the reason last.
  const traceback = (reason: string): string => [
    'Traceback (most recent call last):',
    '  File "<frozen runpy>", line 198, in _run_module_as_main',
    '  File "C:\\App\\resources\\python-runtime\\Lib\\site-packages\\edge_tts\\__main__.py", line 6, in <module>',
    '    main()',
    reason
  ].join('\n')

  it('names the real reason instead of the start of the traceback', () => {
    const message = explainEdgeTtsFailure(1, traceback('ValueError: Invalid voice \'km-XX\''))
    expect(message).toBe("Edge TTS failed (exit 1): ValueError: Invalid voice 'km-XX'")
    expect(message).not.toContain('Traceback')
  })

  it('explains NoAudioReceived in plain words', () => {
    expect(explainEdgeTtsFailure(1, traceback('edge_tts.exceptions.NoAudioReceived: No audio was received. Please verify that your parameters are correct.')))
      .toContain('sent back no audio')
  })

  it('judges by the final failure, not an earlier retried attempt', () => {
    const stderr = ['attempt 1 failed (NoAudioReceived); retrying', 'aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host speech.platform.bing.com:443'].join('\n')
    expect(explainEdgeTtsFailure(1, stderr)).toContain("could not reach Microsoft's voice service")
  })

  it('recognises a network problem', () => {
    expect(explainEdgeTtsFailure(1, traceback('aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host speech.platform.bing.com:443')))
      .toContain("could not reach Microsoft's voice service")
  })
})
