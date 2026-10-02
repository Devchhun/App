import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { getBundledPythonPath } from '../ai/pythonRuntime'
import { unreadableScriptFor, voiceLanguageOf } from '@shared/ttsLanguage'
import { runInBackground } from './processPriority'

/** python-worker/edge_tts_runner.py: edge_tts at 96 kbps instead of the
 * 48 kbps stream the library hard-codes. At 48 kbps every line carries MP3
 * holes across its upper spectrum -- the crackly, bubbly "អុចៗ" heard in
 * both recap narration and dubbing. See the script's own header. */
export function edgeRunnerPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python-worker', 'edge_tts_runner.py') : join(__dirname, '../../python-worker/edge_tts_runner.py')
}

/** Edge TTS runs on the app's OWN bundled Python (resources/python-runtime,
 * the same one shipped for transcription) with `edge_tts` pre-installed into
 * it -- so it works out of the box with nothing for the user to download,
 * install or point at. Only the interpreter is needed: no model weights, no
 * GPU, no source package, which is why this checks far less than
 * voxcpmTts.ts's validateVoxCpmInstall.
 *
 * Falls back to the user's VoxCPM2 portable runtime only if this build has
 * no bundled Python at all (e.g. a dev checkout before
 * scripts/fetch-portable-python.ps1 has run), so development keeps working
 * without special-casing it. */
export function edgePythonExe(installDir: string): string {
  return getBundledPythonPath() ?? join(installDir, 'voxcpm_runtime', 'python.exe')
}

export interface ValidateEdgeTtsResult {
  ok: boolean
  missing: string[]
}

export function validateEdgeTtsInstall(installDir: string): ValidateEdgeTtsResult {
  const pythonExe = edgePythonExe(installDir)
  return existsSync(pythonExe) ? { ok: true, missing: [] } : { ok: false, missing: [pythonExe] }
}

/** Builds `python -m edge_tts --voice ... --text ... --write-media ...`'s
 * exact argument array -- pure and independently testable. Edge TTS has no
 * batch mode: one invocation produces one line, which is fine here because
 * each call costs ~1.5s with no model to load (unlike VoxCPM2, where
 * batching by voice exists purely to pay that load cost once). */
export function buildEdgeTtsArgs(voice: string, text: string, outPath: string, runnerPath: string | null = existsSync(edgeRunnerPath()) ? edgeRunnerPath() : null): string[] {
  // The stock CLI only if the runner is missing (an incomplete build):
  // same arguments, 48 kbps sound.
  const entry = runnerPath ? [runnerPath] : ['-m', 'edge_tts']
  return [...entry, '--voice', voice, '--text', text, '--write-media', outPath]
}

/** True when `text` has at least one letter or digit, in any script. Edge
 * TTS returns no audio at all for a line of only symbols ("…", "♪♪", "—",
 * "!?", an emoji) and edge_tts then exits 1 with NoAudioReceived. */
export function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/** The useful part of a failed run's stderr. Python prints the traceback
 * FIRST and the actual exception LAST, so the old "first 300 characters"
 * showed `Traceback … File "C:` and cut off the reason every time. */
export function explainEdgeTtsFailure(code: number | null, stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  // Lines with no words never get here (hasSpeakableText refuses them
  // first), so an empty stream is Microsoft's service, not the text: the
  // runner has already asked again three times, a few seconds apart.
  if (/NoAudioReceived/i.test(last)) {
    return "Microsoft's voice service sent back no audio for this line, even after retrying (it is busy or limiting requests) — wait a minute, then generate the failed lines again."
  }
  if (/ClientConnector|getaddrinfo|Cannot connect|TimeoutError|ServerDisconnected|WSServerHandshakeError|\b403\b|\b429\b/i.test(stderr)) {
    return `Edge TTS could not reach Microsoft's voice service (no internet, blocked, or busy — try again). ${last.slice(0, 200)}`
  }
  return `Edge TTS failed (exit ${code}): ${last.slice(0, 300) || 'no error output'}`
}

/** Edge TTS is a network call to Microsoft's endpoint, so a hung request
 * must not wedge the whole run. Generous enough for a long line on a slow
 * connection, short enough that a dead network fails a batch in minutes
 * rather than never. */
const LINE_TIMEOUT_MS = 60_000

/** Synthesizes ONE line to its own file. Rejects on a non-zero exit, a
 * spawn failure, or the timeout above; resolves with the output path only
 * once the file actually exists (edge_tts exits 0 having written nothing if
 * the text was empty after its own normalization). */
/** A line the voice cannot read at all (Chinese text for a Khmer voice).
 * Retrying it never helps, so callers fail it at once instead. */
export class EdgeTtsUnreadableTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdgeTtsUnreadableTextError'
  }
}

/** Rejection reason when a line is stopped by Cancel -- not a failure. */
export class EdgeTtsCanceledError extends Error {
  constructor() {
    super('Canceled')
    this.name = 'EdgeTtsCanceledError'
  }
}

export function runEdgeTtsLine(installDir: string, voice: string, text: string, outPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EdgeTtsCanceledError())
      return
    }
    // Refuse up front rather than start Python, wait for Microsoft, and get
    // a NoAudioReceived traceback back.
    if (!hasSpeakableText(text)) {
      reject(new Error('This line has no words to speak (only symbols like … or ♪) — no voice was made for it.'))
      return
    }
    // A Khmer voice sends back NO audio for Chinese text, every time --
    // that is an untranslated subtitle, not a busy server.
    const script = unreadableScriptFor(text, voiceLanguageOf(voice))
    if (script) {
      reject(
        new EdgeTtsUnreadableTextError(
          `This line is still in ${script} ("${text.slice(0, 24)}${text.length > 24 ? '…' : ''}") — the ${voiceLanguageOf(voice) === 'km' ? 'Khmer' : 'English'} voice cannot read ${script}. Translate the subtitles first (Translate to Khmer), then generate again.`
        )
      )
      return
    }
    const proc = runInBackground(spawn(edgePythonExe(installDir), buildEdgeTtsArgs(voice, text, outPath)))
    // Cancel stops the line in flight, not just the ones after it.
    let canceled = false
    const onAbort = (): void => {
      canceled = true
      proc.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Edge TTS timed out after ${LINE_TIMEOUT_MS / 1000}s (no internet?)`))
    }, LINE_TIMEOUT_MS)

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(canceled ? new EdgeTtsCanceledError() : err)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (canceled) {
        reject(new EdgeTtsCanceledError())
        return
      }
      if (code !== 0) {
        reject(new Error(explainEdgeTtsFailure(code, stderr)))
        return
      }
      if (!existsSync(outPath)) {
        reject(new Error('Edge TTS reported success but wrote no audio file for this line.'))
        return
      }
      resolve(outPath)
    })
  })
}

/** One temp directory per generation run, so each line's own mp3 gets a
 * stable, collision-free path (mirrors runVoxCpmBatch's own mkdtemp). */
export async function createEdgeTtsWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'edge-tts-'))
}

export function edgeTtsOutputPath(workDir: string, index: number): string {
  return join(workDir, `line_${String(index + 1).padStart(4, '0')}.mp3`)
}
