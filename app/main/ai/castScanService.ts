import { spawn } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { extractTranscriptionAudio } from '../media/audioExtract'
import { cacheKeyForFile, ensureCacheDir, getMediaCacheRoot } from '../media/cache'
import { cancelJob, runFfmpeg } from '../media/jobRunner'
import { runInBackground } from '../media/processPriority'
import { separateSpeechForTranscription } from '../media/vocalRemoval'
import { detectVoxCpmInstalls } from '../media/voxcpmDiscovery'
import { fileNameSafe, validateVoxCpmInstall } from '../media/voxcpmTts'
import { getBundledPythonPath } from './pythonRuntime'
import type { SpeakerGender } from '@shared/transcription'
import {
  faceCandidates,
  groupGender,
  groupVoicePrints,
  VOICE_THRESHOLD_MIX,
  VOICE_THRESHOLD_SPEECH_ONLY,
  voiceGenderScore,
  type CastGroup,
  type CastScanLine,
  type CastScanProgress,
  type CastScanRequest,
  type CastScanResult,
  type VoicePrint
} from '@shared/cast'

/** The Cast scan (shared/cast.ts): every subtitle line of the open video(s)
 * is listened to and the lines are grouped by who is speaking; each voice
 * then gets faces cut from the frames its lines are spoken over.
 *
 * Two small networks do the recognizing, run by the app's own Python
 * (numpy + onnxruntime, see python-worker/cast_*_runner.py). They ship with
 * the app; a build made without them fetches them once. */
interface ModelFile {
  file: string
  urls: string[]
  minBytes: number
  what: string
}

/** CAM++ speaker recognition (3D-Speaker, Chinese + English, Apache-2.0). */
const VOICE_MODEL: ModelFile = {
  file: 'cast-voices-campplus.onnx',
  urls: [
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
    'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
  ],
  // 28.28 MB: anything much smaller is a broken download.
  minBytes: 26 * 1024 * 1024,
  what: 'voice recognizer'
}
/** Ultra-Light-Fast-Generic-Face-Detector, RFB-640 (MIT). */
const FACE_MODEL: ModelFile = {
  file: 'cast-faces-rfb640.onnx',
  urls: [
    'https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-640.onnx',
    'https://huggingface.co/onnxmodelzoo/version-RFB-640/resolve/main/version-RFB-640.onnx'
  ],
  minBytes: 1400 * 1024,
  what: 'face finder'
}

/** The frame a face is looked for in (what cast_faces_runner.py expects). */
const FRAME_WIDTH = 1280
const FRAME_HEIGHT = 960
const PORTRAIT_PIXELS = 384
/** Portraits kept per voice. */
const FACES_PER_VOICE = 4
/** Frames grabbed at once. */
const PARALLEL_FRAMES = 3
/** Voices that get portraits: the tail of one-line voices goes without. */
const VOICES_WITH_FACES = 40

class CastScanCanceled extends Error {
  constructor() {
    super('Canceled')
    this.name = 'CastScanCanceled'
  }
}

const activeScans = new Map<string, AbortController>()

function scriptDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python-worker') : join(__dirname, '../../python-worker')
}

function bundledModelDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'cast-models') : join(__dirname, '../../resources/cast-models')
}

async function isWhole(path: string, minBytes: number): Promise<boolean> {
  try {
    return (await stat(path)).size >= minBytes
  } catch {
    return false
  }
}

/** The model file: the one shipped with the app, else the one fetched
 * before, else fetched now (into the app's data). */
async function ensureModel(model: ModelFile, onFraction: (fraction: number) => void, signal: AbortSignal): Promise<string> {
  const bundled = join(bundledModelDir(), model.file)
  if (await isWhole(bundled, model.minBytes)) return bundled
  const dir = join(app.getPath('userData'), 'models')
  const target = join(dir, model.file)
  if (await isWhole(target, model.minBytes)) return target
  await mkdir(dir, { recursive: true })
  let lastError: unknown = null
  for (const url of model.urls) {
    const partPath = `${target}.${Date.now()}.part`
    try {
      const res = await fetch(url, { signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      const file = createWriteStream(partPath)
      let received = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
        if (total) onFraction(received / total)
      }
      await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
      if (received < model.minBytes) throw new Error('download cut short')
      await rename(partPath, target)
      return target
    } catch (error) {
      if (signal.aborted) throw new CastScanCanceled()
      lastError = error
    } finally {
      await unlink(partPath).catch(() => undefined)
    }
  }
  throw new Error(`The ${model.what} could not be downloaded (${lastError instanceof Error ? lastError.message : String(lastError)}). Check the internet connection and try again.`)
}

/** One of the cast runners, to its end. They print "progress <0-1>" lines
 * and "ok <count>" when done. */
/** A runner of python-worker/ run on the app's Python (Auto Reframe's
 * face look uses it too). */
export function runCastRunner(script: string, jobPath: string, onFraction: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  return runRunner(script, jobPath, onFraction, signal)
}

/** The face finder's model file (shipped with the app, or fetched once). */
export function faceModelPath(signal: AbortSignal): Promise<string> {
  return ensureModel(FACE_MODEL, () => undefined, signal)
}

function runRunner(script: string, jobPath: string, onFraction: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  const python = getBundledPythonPath()
  if (!python) return Promise.reject(new Error("Scanning the voices needs the app's bundled Python, which this build is missing. Reinstalling the app should restore it."))
  return new Promise((resolve, reject) => {
    const proc = runInBackground(spawn(python, [join(scriptDir(), script), jobPath], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true }))
    let tail = ''
    let ok = false
    let pending = ''
    proc.stdout.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^progress ([\d.]+)/.exec(line)
        if (m) onFraction(Number(m[1]))
        else if (/^ok /.test(line)) ok = true
      }
    })
    proc.stderr.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)))
    const onAbort = (): void => {
      proc.kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new CastScanCanceled())
      else if (code === 0 && (ok || /^ok /m.test(pending))) resolve()
      else reject(new Error(tail.trim().split('\n').slice(-3).join('\n') || `${script} stopped (code ${code}).`))
    })
  })
}

/** When the drives were last searched for a VoxCPM2 install and none was
 * there (see speakerDiarizationService.ts's own copy of this rule). */
let noInstallSearchedAt = 0

async function separatorInstall(stored?: string): Promise<string | undefined> {
  if (stored?.trim() && validateVoxCpmInstall(stored.trim()).ok) return stored.trim()
  if (Date.now() - noInstallSearchedAt < 10 * 60_000) return undefined
  const found = (await detectVoxCpmInstalls(stored))[0]
  if (!found) noInstallSearchedAt = Date.now()
  return found
}

/** A file's sound as the 16 kHz WAV the voice recognizer reads: its speech
 * alone when that was made before (Auto SRT makes it) or can be made now,
 * else everything in it. Null for a file with no sound. */
async function soundOf(path: string, request: CastScanRequest, index: number, signal: AbortSignal, onFraction: (fraction: number) => void): Promise<{ wav: string; speechOnly: boolean } | null> {
  const cacheDir = await ensureCacheDir(await cacheKeyForFile(path))
  const speech = join(cacheDir, 'speech-vocals-16k.wav')
  if (existsSync(speech)) return { wav: speech, speechOnly: true }
  if (request.removeMusic) {
    const installDir = await separatorInstall(request.voxCpmInstallDir)
    if (installDir) {
      const partPath = join(cacheDir, 'speech-vocals-16k.part.wav')
      const made = await separateSpeechForTranscription(`${request.jobId}:speech-${index}`, path, partPath, installDir, signal, onFraction)
      if (signal.aborted) throw new CastScanCanceled()
      if (made) {
        await rename(partPath, speech)
        return { wav: speech, speechOnly: true }
      }
      await unlink(partPath).catch(() => undefined)
    }
  }
  try {
    return { wav: (await extractTranscriptionAudio(`cast-${Date.now().toString(36)}-${index}`, path, cacheDir)).outputPath, speechOnly: false }
  } catch {
    return null
  }
}

/** Runs `work` over `items`, a few at a time. */
async function inParallel<T>(items: T[], most: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) await work(items[i], i)
  }
  await Promise.all(Array.from({ length: Math.min(most, items.length) }, worker))
}

interface FaceFrame {
  id: string
  group: number
  rgb: string
}

/** Portraits for each voice: frames from the middle of its clearest lines,
 * the face in each found and cut out (cast_faces_runner.py says where).
 * Best first; a voice whose frames show no face gets the frame's middle. */
async function facesFor(
  jobId: string,
  groups: { sampleIds: string[] }[],
  lines: Map<string, CastScanLine>,
  workDir: string,
  signal: AbortSignal,
  onFraction: (fraction: number) => void
): Promise<string[][]> {
  const faces: string[][] = groups.map(() => [])
  const wanted: { id: string; group: number; line: CastScanLine }[] = []
  groups.slice(0, VOICES_WITH_FACES).forEach((group, g) => {
    for (const id of faceCandidates(group.sampleIds, lines)) wanted.push({ id: `${g}-${id}`, group: g, line: lines.get(id) as CastScanLine })
  })
  if (wanted.length === 0) return faces
  // The preview copy when there is one: a frame out of a 4K original takes
  // seconds, out of its small copy a tenth of one.
  const pictureOf = new Map<string, string>()
  for (const path of new Set(wanted.map((w) => w.line.path))) {
    const proxy = join(await ensureCacheDir(await cacheKeyForFile(path)), 'proxy.mp4')
    pictureOf.set(path, existsSync(proxy) ? proxy : path)
  }
  const frames: FaceFrame[] = []
  let grabbed = 0
  await inParallel(wanted, PARALLEL_FRAMES, async (item, index) => {
    if (signal.aborted) return
    const rgb = join(workDir, `frame-${index}.rgb`)
    const { start, end } = item.line
    try {
      await runFfmpeg(`${jobId}:frame-${index}`, [
        '-y', '-ss', (start + (end - start) * 0.45).toFixed(3), '-i', pictureOf.get(item.line.path) as string, '-frames:v', '1', '-an',
        '-vf', `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgb
      ])
      if ((await stat(rgb)).size === FRAME_WIDTH * FRAME_HEIGHT * 3) frames.push({ id: item.id, group: item.group, rgb })
    } catch {
      // No picture at that moment (a sound-only file, the very end): this line gives no face.
    }
    onFraction((++grabbed / wanted.length) * 0.6)
  })
  if (signal.aborted) throw new CastScanCanceled()
  if (frames.length === 0) return faces

  const facePath = await ensureModel(FACE_MODEL, () => undefined, signal)
  const jobPath = join(workDir, 'faces-job.json')
  const outPath = join(workDir, 'faces-out.json')
  await writeFile(jobPath, JSON.stringify({ model: facePath, out: outPath, frames: frames.map(({ id, rgb }) => ({ id, rgb })) }), 'utf-8')
  await runRunner('cast_faces_runner.py', jobPath, (f) => onFraction(0.6 + f * 0.25), signal)
  const found = (JSON.parse(await readFile(outPath, 'utf-8')) as { frames: { id: string; left: number; top: number; side: number; face: boolean; score: number; size: number }[] }).frames
  const frameOf = new Map(frames.map((frame) => [frame.id, frame]))

  const outDir = join(getMediaCacheRoot(), 'generated', 'cast', fileNameSafe(jobId))
  await mkdir(outDir, { recursive: true })
  // The surest, biggest faces first; a frame with no face only when the
  // voice has no face at all.
  const ranked = found
    .map((f) => ({ ...f, frame: frameOf.get(f.id) as FaceFrame, rank: f.face ? Math.min(f.size, 0.5) + f.score * 0.1 : -1 }))
    .filter((f) => !!f.frame)
    .sort((a, b) => b.rank - a.rank)
  const chosen: typeof ranked = []
  const perGroup = new Map<number, number>()
  const hasFace = new Set(ranked.filter((f) => f.face).map((f) => f.frame.group))
  for (const f of ranked) {
    const count = perGroup.get(f.frame.group) ?? 0
    if (count >= FACES_PER_VOICE || (!f.face && (hasFace.has(f.frame.group) || count >= 1))) continue
    perGroup.set(f.frame.group, count + 1)
    chosen.push(f)
  }
  let cut = 0
  await inParallel(chosen, PARALLEL_FRAMES, async (f, index) => {
    if (signal.aborted) return
    const jpg = join(outDir, `voice${f.frame.group + 1}-${index}.jpg`)
    try {
      await runFfmpeg(`${jobId}:face-${index}`, [
        '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${FRAME_WIDTH}x${FRAME_HEIGHT}`, '-i', f.frame.rgb,
        '-vf', `crop=${f.side}:${f.side}:${f.left}:${f.top},scale=${PORTRAIT_PIXELS}:${PORTRAIT_PIXELS}:flags=lanczos`, '-frames:v', '1', '-q:v', '3', jpg
      ])
      // `chosen` is best-first, but the cutting finishes in any order.
      faces[f.frame.group][index] = jpg
    } catch {
      // This portrait is left out.
    }
    onFraction(0.85 + (++cut / chosen.length) * 0.15)
  })
  if (signal.aborted) throw new CastScanCanceled()
  return faces.map((list) => list.filter(Boolean))
}

export async function scanCast(request: CastScanRequest, onProgress: (progress: CastScanProgress) => void): Promise<CastScanResult> {
  if (activeScans.has(request.jobId)) throw new Error(`A voice scan is already running: ${request.jobId}`)
  const controller = new AbortController()
  const signal = controller.signal
  activeScans.set(request.jobId, controller)
  const report = (stage: CastScanProgress['stage'], percent: number, message: string): void => onProgress({ jobId: request.jobId, stage, percent: Math.round(percent * 10) / 10, message })
  const workDir = await mkdtemp(join(tmpdir(), 'cast-scan-'))
  try {
    const lines = request.lines.filter((line) => line.end > line.start)
    if (lines.length === 0) throw new Error('There are no subtitle lines to listen to.')
    report('model', 1, 'Getting the voice recognizer ready…')
    const voiceModel = await ensureModel(VOICE_MODEL, (f) => report('model', 1 + f * 3, `Downloading the voice recognizer (once)… ${Math.round(f * 100)}%`), signal)

    // Each file's sound, its speech alone where that can be had.
    const paths = [...new Set(lines.map((line) => line.path))]
    const sounds = new Map<string, { wav: string; speechOnly: boolean }>()
    for (let i = 0; i < paths.length; i++) {
      if (signal.aborted) throw new CastScanCanceled()
      const label = paths.length > 1 ? ` (video ${i + 1} of ${paths.length})` : ''
      report('audio', 4 + (i / paths.length) * 36, `Reading the sound${label}…`)
      const sound = await soundOf(paths[i], request, i, signal, (f) => report('audio', 4 + ((i + f) / paths.length) * 36, `Taking the music out, so only the voices are heard${label}… ${Math.round(f * 100)}%`))
      if (sound) sounds.set(paths[i], sound)
    }
    if (sounds.size === 0) throw new Error('None of these videos has any sound to listen to.')

    report('voices', 40, `Listening to ${lines.length} lines…`)
    const jobPath = join(workDir, 'voices-job.json')
    const outPath = join(workDir, 'voices-out.json')
    const files = [...sounds].map(([path, sound]) => ({ wav: sound.wav, lines: lines.filter((line) => line.path === path).map(({ id, start, end }) => ({ id, start, end })) }))
    await writeFile(jobPath, JSON.stringify({ model: voiceModel, out: outPath, files }), 'utf-8')
    await runRunner('cast_voices_runner.py', jobPath, (f) => report('voices', 40 + f * 35, `Listening to ${lines.length} lines… ${Math.round(f * 100)}%`), signal)
    const prints = (JSON.parse(await readFile(outPath, 'utf-8')) as { lines: VoicePrint[] }).lines
    if (prints.length === 0) throw new Error('No voice could be heard on these lines.')

    report('grouping', 76, 'Telling the voices apart…')
    const lineOf = new Map(lines.map((line) => [line.id, line]))
    const heardSpeechOnly = prints.filter((print) => sounds.get((lineOf.get(print.id) as CastScanLine).path)?.speechOnly).length
    const speechOnly = heardSpeechOnly >= prints.length * 0.9
    const voiceGroups = groupVoicePrints(prints, speechOnly ? VOICE_THRESHOLD_SPEECH_ONLY : VOICE_THRESHOLD_MIX)

    report('faces', 78, 'Finding each speaker’s face…')
    const faces = await facesFor(request.jobId, voiceGroups, lineOf, workDir, signal, (f) => report('faces', 78 + f * 21, 'Finding each speaker’s face…')).catch((error) => {
      if (error instanceof CastScanCanceled) throw error
      // The voices are what was asked for: without faces they still stand.
      return voiceGroups.map(() => [] as string[])
    })

    const groups: CastGroup[] = voiceGroups.map((group, index) => {
      const gender = groupGender(group)
      return {
        lineIds: group.lineIds,
        unsureIds: group.unsureIds,
        sampleIds: group.sampleIds,
        gender: gender.gender,
        genderConfidence: gender.confidence,
        seconds: Math.round(group.seconds * 10) / 10,
        faces: faces[index] ?? [],
        embedding: group.centroid
      }
    })
    const heard = new Set(prints.map((print) => print.id))
    report('ready', 100, `Found ${groups.length} voice${groups.length === 1 ? '' : 's'} in ${prints.length} lines.`)
    return { groups, unheardIds: request.lines.filter((line) => !heard.has(line.id)).map((line) => line.id), speechOnly }
  } catch (error) {
    if (signal.aborted) throw new CastScanCanceled()
    throw error
  } finally {
    activeScans.delete(request.jobId)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Male or female for every given subtitle line -- the Detect Gender
 * review's answer. Each line's voice print (CAM++, as the Cast window's)
 * is taken from the video's own sound, the lines are grouped by voice, and
 * a line gets its group's answer by the voice-print rule (castGenderRule.ts);
 * a line no group could tell is answered from its own print.
 *
 * It replaces the pitch of each line on its own (media/speakerDetect.ts):
 * measured on 479 lines the user had voiced by hand across five episodes,
 * pitch was right on 63% -- a man shouting over music came out a woman on
 * 158 of 303 men's lines -- and this on 95%. The film's own sound, not the
 * voices alone: on the same lines the Demucs speech stem told men from
 * women worse (91%). */
export async function detectLineGenders(request: { jobId: string; lines: CastScanLine[] }): Promise<Record<string, { gender: SpeakerGender; confidence: number }>> {
  if (activeScans.has(request.jobId)) throw new Error(`A voice scan is already running: ${request.jobId}`)
  const controller = new AbortController()
  const signal = controller.signal
  activeScans.set(request.jobId, controller)
  const workDir = await mkdtemp(join(tmpdir(), 'line-genders-'))
  try {
    const lines = request.lines.filter((line) => line.end > line.start)
    if (lines.length === 0) return {}
    const voiceModel = await ensureModel(VOICE_MODEL, () => undefined, signal)
    const paths = [...new Set(lines.map((line) => line.path))]
    const files: { wav: string; lines: { id: string; start: number; end: number }[] }[] = []
    for (let i = 0; i < paths.length; i++) {
      if (signal.aborted) throw new CastScanCanceled()
      const cacheDir = await ensureCacheDir(await cacheKeyForFile(paths[i]))
      try {
        const wav = (await extractTranscriptionAudio(`genders-${Date.now().toString(36)}-${i}`, paths[i], cacheDir)).outputPath
        files.push({ wav, lines: lines.filter((line) => line.path === paths[i]).map(({ id, start, end }) => ({ id, start, end })) })
      } catch {
        // A file with no sound: its lines stay unknown.
      }
    }
    if (files.length === 0) return {}
    const jobPath = join(workDir, 'voices-job.json')
    const outPath = join(workDir, 'voices-out.json')
    await writeFile(jobPath, JSON.stringify({ model: voiceModel, out: outPath, files }), 'utf-8')
    await runRunner('cast_voices_runner.py', jobPath, () => undefined, signal)
    const prints = (JSON.parse(await readFile(outPath, 'utf-8')) as { lines: VoicePrint[] }).lines.filter((print) => print.embedding.length > 0)
    const answers: Record<string, { gender: SpeakerGender; confidence: number }> = {}
    for (const group of groupVoicePrints(prints, VOICE_THRESHOLD_MIX)) {
      const gender = groupGender(group)
      for (const id of group.lineIds) answers[id] = gender
    }
    for (const print of prints) {
      if (answers[print.id] && answers[print.id].gender !== 'unknown') continue
      const score = voiceGenderScore([print.embedding])
      if (score !== undefined && Math.abs(score) >= 0.015) answers[print.id] = { gender: score > 0 ? 'male' : 'female', confidence: Math.min(0.8, 0.4 + Math.abs(score) * 4) }
    }
    return answers
  } finally {
    activeScans.delete(request.jobId)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function cancelCastScan(jobId: string): boolean {
  const controller = activeScans.get(jobId)
  if (!controller) return false
  controller.abort()
  // The ffmpeg jobs it started are all named `<jobId>:<part>`.
  cancelJob(jobId)
  return true
}

export function isCastScanCanceled(error: unknown): boolean {
  return error instanceof CastScanCanceled
}
