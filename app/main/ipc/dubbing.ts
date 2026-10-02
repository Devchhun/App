import { detectBurnedSubtitles } from '../media/subtitleDetect'
import { kiriSpeakLine, KiriTtsError } from '../media/kiriTts'
import { kiriExpectedSeconds, kiriInstructions, kiriRetake, kiriTakeVerdict, kiriVoiceId } from '@shared/kiriTts'

/** Lines asked of KiriTTS at once -- well inside its 100 requests/minute. */
const KIRI_PARALLEL_LINES = 3
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { analyzeEcho } from '@shared/innerVoice'
import { cacheKeyForFile, ensureCacheDir, getMediaCacheRoot } from '../media/cache'
import { runFfmpeg } from '../media/jobRunner'
import { registerMediaToken } from '../media/protocol'
import { SUPPORTED_MEDIA_EXTENSIONS } from '@shared/media'
import { basename, join } from 'path'
import {
  DUBBING_IPC,
  type AnalyzePerformanceLine,
  type AnalyzePerformanceResult,
  type DubbingGenerationRequest,
  type DubbingGenerationGroup,
  type DubbingGenerationProgressEvent,
  type PrepareReferenceClipResult,
  type RefitClipAudioResult
} from '@shared/dubbing'
import { buildLineControl, emotionProfile, lineLimiterAllowanceDb, lineLoudnessTargetLufs, restrainedPerformance, type DubbingLineDebug } from '@shared/dubbingPerformance'
import { analyzeDubbingPerformance, DUBBING_PERFORMANCE_MODEL } from '../ai/dubbingPerformanceService'
import { extractDubPlaceholderClip } from '../media/dubbingAudio'
import { cutTake, masterDubbingLine, measureSpeechSeconds, measureSpeechSpans } from '../media/dubbingMaster'
import { stitchAudio } from '../media/audioStitch'
import {
  applyDubbingPostFx,
  computeAutoFitSpeed,
  ensureReferenceCloneLength,
  ensureVoiceMatcherInstalled,
  ensureVoiceReferenceClip,
  bundledVoiceReferencePath,
  measureReferenceClipQuality,
  performanceSeedFor,
  voiceSeedFor,
  prepareReferenceClip,
  readPitchCorrection,
  runVoxCpmBatch,
  type RunnerLineJob,
  validateReferenceAudioDuration,
  validateVoxCpmInstall
} from '../media/voxcpmTts'
import { detectVoxCpmInstalls } from '../media/voxcpmDiscovery'
import { validateEdgeTtsInstall, runEdgeTtsLine, createEdgeTtsWorkDir, edgeTtsOutputPath, EdgeTtsCanceledError, EdgeTtsUnreadableTextError } from '../media/edgeTts'
import { probeMedia } from '../media/probe'

/** Running batches, keyed by their batchId (AI Dubber's own untagged batch
 * uses AI_DUBBER_BATCH). Cancel aborts the controller: loops stop starting
 * new lines, the voice process in flight is killed, and nothing further is
 * reported for the lines left unmade. */
const AI_DUBBER_BATCH = 'ai-dubber'
const runningBatches = new Map<string, AbortController>()

/** How long Edge TTS lines Microsoft turned down wait before their second
 * pass -- long enough for a rate-limit burst to pass. */
const EDGE_RETRY_PAUSE_MS = 15_000

/** Resolves after `ms`, or at once when the run is canceled. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** AI Dubber's main-process side: the VoxCPM2 / Edge TTS engines, the
 * Custom Voice reference-clip preparation, and the per-line audio
 * post-processing every generated line goes through. */
/** The time a line may take: up to the next line's start, else its own end. */
function roomSecondsOf(segment: DubbingGenerationGroup['segments'][number]): number {
  return segment.nextSegmentStartTime !== undefined ? Math.max(0.1, segment.nextSegmentStartTime - segment.startTime) : Math.max(0.1, segment.endTime - segment.startTime)
}

/** The most a line's audio is ever stretched in all (when it is made, plus
 * Auto-Speed afterwards) -- the same ceiling as the speed-fit at
 * generation. */
const REFIT_TOTAL_STRETCH_MAX = 1.28

/** How many more times a babbling KiriTTS take is asked for (each costs
 * credits; the third try still babbling is capped, not asked again). */
const KIRI_BABBLE_RETRIES = 2

/** How much a generated line was already sped up when it was made: its
 * final file against the levelled take saved beside it
 * ("x.master.wav" -> "x.master.<job>.fx.wav"; only tempo changes a line's
 * length). 1 when that take is gone. */
async function stretchAlreadyApplied(finalPath: string): Promise<number> {
  const match = /^(.*\.master)\.[^\\/]+\.fx\.wav$/i.exec(finalPath)
  if (!match || /\.refit-/i.test(finalPath) || !existsSync(`${match[1]}.wav`)) return 1
  try {
    const [master, final] = await Promise.all([probeMedia(`${match[1]}.wav`), probeMedia(finalPath)])
    return final.durationSeconds > 0 && master.durationSeconds > final.durationSeconds ? master.durationSeconds / final.durationSeconds : 1
  } catch {
    return 1
  }
}

export function registerDubbingIpc(): void {
  ipcMain.handle(DUBBING_IPC.cancelGeneration, (_event, batchId?: string): boolean => {
    const controller = runningBatches.get(batchId || AI_DUBBER_BATCH)
    if (!controller) return false
    controller.abort()
    return true
  })

  ipcMain.handle(
    DUBBING_IPC.extractPlaceholderClip,
    async (_event, args: { jobId: string; sourcePath: string; startTime: number; endTime: number }) =>
      extractDubPlaceholderClip(args.jobId, args.sourcePath, args.startTime, args.endTime)
  )

  ipcMain.handle(
    DUBBING_IPC.refitClipAudio,
    async (_event, args: { jobId: string; sourcePath: string; speed: number }): Promise<RefitClipAudioResult> => {
      try {
        // Never past REFIT_TOTAL_STRETCH_MAX in all: a line already sped
        // up when it was made (up to 1.28x) and then by Auto-Speed (1.25x)
        // came out at 1.6x -- too fast and smeared to understand.
        const already = await stretchAlreadyApplied(args.sourcePath)
        const speed = Math.min(args.speed, REFIT_TOTAL_STRETCH_MAX / already)
        if (speed < 1.02) return { ok: false, error: 'This line is already as fast as it can be made and stay clear.' }
        const outputPath = await applyDubbingPostFx(args.jobId, args.sourcePath, { pitch: 0, speed, volumeDb: 0 })
        return { ok: true, outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    DUBBING_IPC.prepareReferenceClip,
    async (_event, args: { jobId: string; sourcePath: string; installDir?: string; level?: boolean }): Promise<PrepareReferenceClipResult> => {
      try {
        const outputPath = await prepareReferenceClip(args.jobId, args.sourcePath, { level: !!args.level })
        const { durationSeconds } = await probeMedia(outputPath)
        // The install folder is what makes the quality verdict possible
        // (measured by the runtime's own speaker encoder); without one the
        // clip is still prepared, just not judged.
        const quality = args.installDir ? await measureReferenceClipQuality(args.installDir, outputPath) : null
        return quality ? { ok: true, outputPath, durationSeconds, quality } : { ok: true, outputPath, durationSeconds }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(DUBBING_IPC.validateInstall, async (_event, installDir: string) => validateVoxCpmInstall(installDir))

  // Emotion + performance analysis with context (Gemini). The renderer falls
  // back to its local rules analyzer when this fails (no key, no credits,
  // offline) -- see AiDubberContext's detectEmotions.
  ipcMain.handle(DUBBING_IPC.analyzePerformance, async (_event, args: { jobId: string; lines: AnalyzePerformanceLine[] }): Promise<AnalyzePerformanceResult> => {
    const controller = new AbortController()
    try {
      const performances = await analyzeDubbingPerformance(args.lines, controller.signal)
      return { ok: true, performances, model: DUBBING_PERFORMANCE_MODEL }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(DUBBING_IPC.detectInstalls, async (_event, knownPath?: string) => detectVoxCpmInstalls(knownPath))

  ipcMain.handle(DUBBING_IPC.pickInstallFolder, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Select the VoxCPM2 installation folder', properties: ['openDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })

  ipcMain.handle(
    DUBBING_IPC.pickVideosAndSrt,
    async (event): Promise<{ videoPaths: string[]; srt: { fileName: string; srtText: string } | null; srts: { fileName: string; srtText: string }[] }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: 'Add video(s) and SRT',
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [
          { name: 'Video & SRT', extensions: [...SUPPORTED_MEDIA_EXTENSIONS, 'srt'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (result.canceled) return { videoPaths: [], srt: null, srts: [] }
      const isSrt = (path: string): boolean => /\.srt$/i.test(path)
      // Any number of SRTs: each goes to its own video (matched by name in
      // the renderer -- see shared/dubbingBatch.ts's pairSrtsWithVideos).
      const srts = await Promise.all(result.filePaths.filter(isSrt).map(async (path) => ({ fileName: basename(path), srtText: await readFile(path, 'utf-8') })))
      return {
        videoPaths: result.filePaths.filter((path) => !isSrt(path)),
        srt: srts[0] ?? null,
        srts
      }
    }
  )

  // Inner-voice detection: the video's own audio, decoded once (mono 8 kHz,
  // cached beside its other media cache files), then every line scored for
  // echo/reverb -- see shared/innerVoice.ts.
  ipcMain.handle(
    DUBBING_IPC.detectEchoLines,
    async (_event, args: { originalPath: string; lines: { id: string; startTime: number; endTime: number }[] }): Promise<{ id: string; score: number }[]> => {
      const dir = await ensureCacheDir(await cacheKeyForFile(args.originalPath))
      const pcmPath = join(dir, 'echo-8k-mono.s16le')
      if (!existsSync(pcmPath)) {
        // Into a temp name first: a decode cut short (stalled, app closed)
        // left a half file that every later run took as the whole sound.
        const partPath = `${pcmPath}.${Date.now()}.part`
        try {
          await runFfmpeg(`echo-decode-${Date.now()}`, ['-y', '-i', args.originalPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', partPath])
          await rename(partPath, pcmPath)
        } finally {
          await unlink(partPath).catch(() => {})
        }
      }
      const buffer = await readFile(pcmPath)
      const samples = new Float32Array(Math.floor(buffer.length / 2))
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768
      return args.lines.map((line) => ({ id: line.id, score: analyzeEcho(samples, 8000, line.startTime, line.endTime).score }))
    }
  )

  ipcMain.handle(DUBBING_IPC.audioUrl, async (_event, filePath: string): Promise<string | null> => (existsSync(filePath) ? registerMediaToken(filePath) : null))
  // Audio Effects: one clip's window of sound through the effect chain, into
  // a new WAV the clip then plays (shared/audioEffects.ts). The input is
  // resampled to 48 kHz first -- the pitch presets assume that rate.
  ipcMain.handle(
    DUBBING_IPC.renderAudioEffect,
    async (_event, args: { jobId: string; inputPath: string; start: number; end: number; filter: string }): Promise<{ ok: true; outputPath: string } | { ok: false; error: string }> => {
      try {
        if (!existsSync(args.inputPath)) return { ok: false, error: 'The original sound file is missing.' }
        const dir = join(getMediaCacheRoot(), 'generated')
        await mkdir(dir, { recursive: true })
        const outputPath = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-fx.wav`)
        const length = Math.max(0.05, args.end - args.start)
        await runFfmpeg(args.jobId, ['-y', '-ss', String(Math.max(0, args.start)), '-i', args.inputPath, '-t', String(length), '-vn', '-af', `aresample=48000,${args.filter}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outputPath])
        return { ok: true, outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  // Subtitle & Blur's Auto-detect: where the video's own subtitles are.
  ipcMain.handle(DUBBING_IPC.detectBurnedSubtitles, async (_event, args: { videoPath: string; lineMiddles: number[] }) =>
    existsSync(args.videoPath) ? detectBurnedSubtitles(args.videoPath, args.lineMiddles).catch(() => null) : null
  )

  ipcMain.handle(
    DUBBING_IPC.saveEpisodeSrts,
    async (event, files: { fileName: string; srtText: string }[]): Promise<{ folder: string; written: number } | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = { title: 'Choose a folder for the episode subtitles (SRT)', properties: ['openDirectory' as const, 'createDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      const folder = result.canceled ? undefined : result.filePaths[0]
      if (!folder) return null
      let written = 0
      for (const file of files) {
        // Only the name: an episode's file name never picks the folder.
        await writeFile(join(folder, basename(file.fileName)), file.srtText, 'utf-8')
        written++
      }
      return { folder, written }
    }
  )

  ipcMain.handle(
    DUBBING_IPC.stitchAudio,
    async (_event, args: { inputPaths: string[]; gapSeconds: number; level?: boolean }): Promise<{ ok: true; outputPath: string } | { ok: false; error: string }> => {
      try {
        const outputPath = await stitchAudio('recap', args.inputPaths, Math.max(0, args.gapSeconds), { level: !!args.level })
        return { ok: true, outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // One batch at a time per call; groups run sequentially -- VoxCPM2 is a
  // full model load per process, and running several batches at once
  // would just contend for VRAM. Never rejects because one group failed: a
  // group that couldn't even start (bad install, model load failure)
  // reports every one of its own segments 'failed' over
  // `generationProgress` and the loop moves on to the next group, so one
  // broken voice never blocks every other line from generating. Resolves
  // once every group has been attempted -- by then every segment has
  // already received its own progress event, so the resolved value itself
  // carries no additional information the renderer needs.
  ipcMain.handle(DUBBING_IPC.generateBatch, async (event, request: DubbingGenerationRequest) => {
    const batchKey = request.batchId || AI_DUBBER_BATCH
    // A new run of the same batch replaces an old one still going.
    runningBatches.get(batchKey)?.abort()
    const controller = new AbortController()
    runningBatches.set(batchKey, controller)
    try {
      await runGenerateBatch(event, request, controller.signal)
    } finally {
      if (runningBatches.get(batchKey) === controller) runningBatches.delete(batchKey)
    }
  })

  const runGenerateBatch = async (event: Electron.IpcMainInvokeEvent, request: DubbingGenerationRequest, signal: AbortSignal): Promise<void> => {
    const send = (payload: DubbingGenerationProgressEvent): void => {
      // After Cancel, a line that did not get made is not a failure.
      if (signal.aborted && payload.status === 'failed') return
      if (!event.sender.isDestroyed()) event.sender.send(DUBBING_IPC.generationProgress, request.batchId ? { ...payload, batchId: request.batchId } : payload)
    }

    const failGroup = (group: DubbingGenerationGroup, message: string): void => {
      for (const segment of group.segments) send({ segmentId: segment.segmentId, status: 'failed', error: message })
    }

    // Everything after a line's raw audio exists is engine-independent:
    // measure it, speed it up if it overran the room before the next line
    // (never past voxcpmTts's ceiling, and never by trimming -- see
    // AiDubberContext.tsx's tryDrainPlacementQueue, which delays the NEXT
    // line's placement instead), apply the segment's own pitch/speed/volume,
    // and report it.
    const finishSegment = async (
      jobId: string,
      segment: DubbingGenerationGroup['segments'][number],
      generatedPath: string,
      report?: { voiceId: string; debug?: Partial<DubbingLineDebug> }
    ): Promise<void> => {
      try {
        // Level, de-click and trim the line FIRST (see dubbingMaster.ts) --
        // the duration the speed-fit below works from is then the speech
        // itself, not speech plus whatever dead air the model put in front.
        // A performance line is levelled to its emotion's loudness (a
        // whisper stays quiet, a shout stays loud); others to the standard.
        const performance = segment.performance
        const loudnessTargetLufs = lineLoudnessTargetLufs(performance)
        const rawPath = await masterDubbingLine(`${jobId}-master`, generatedPath, { targetLufs: loudnessTargetLufs, limiterAllowanceDb: lineLimiterAllowanceDb(performance) })
        const { durationSeconds } = await probeMedia(rawPath)
        const availableSeconds = roomSecondsOf(segment)
        // Steady voice speed: a line keeps the voice's own pace even when
        // it runs past its slot (the placement queue starts the next line
        // after it instead).
        const autoFitSpeed = request.steadyPace ? 1 : computeAutoFitSpeed(durationSeconds, availableSeconds)
        // Pitch match: nudge the take onto the reference voice's baseline
        // (see voxcpmTts.ts's computePitchCorrection) on top of whatever
        // pitch the user asked for.
        // The runner's sidecar decides: a neutral take is pulled onto the
        // voice's pitch; an expressive one only back to its emotion's limit,
        // so it keeps its acting but never becomes another voice.
        const pitchCorrection = await readPitchCorrection(generatedPath)
        const finalPath = await applyDubbingPostFx(jobId, rawPath, {
          pitch: segment.pitch + pitchCorrection,
          speed: segment.speed * autoFitSpeed,
          volumeDb: segment.volumeDb,
          // A thought, not a spoken line: echoed like the original's.
          echo: !!segment.innerVoice
        })
        const debug: DubbingLineDebug | undefined =
          report && performance
            ? {
                control: null,
                ...report.debug,
                voiceId: report.voiceId,
                emotion: performance.emotion,
                intensity: performance.emotionIntensity,
                style: performance.speakingStyle,
                pace: performance.pace,
                energy: performance.energy,
                generatedSeconds: Math.round(durationSeconds * 100) / 100,
                loudnessTargetLufs,
                pitchCorrectionSt: pitchCorrection
              }
            : undefined
        send({ segmentId: segment.segmentId, status: 'generated', outputPath: finalPath, ...(debug ? { debug } : {}) })
      } catch (err) {
        send({ segmentId: segment.segmentId, status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }

    // A cloned voice (reference audio) is VoxCPM2's alone -- with Edge TTS
    // selected, those groups still go to VoxCPM2 while catalog voices go
    // to Edge.
    const edgeGroups = request.engine === 'edge-tts' ? request.groups.filter((g) => !g.referenceAudioPath) : []
    // KiriTTS: every line has a Kiri voice (the renderer maps the others to
    // one of the same gender) -- a group without one is reported, never
    // quietly handed to another engine.
    const kiriGroups = request.engine === 'kiritts' ? request.groups.filter((g) => !!g.kiriVoice) : []
    if (request.engine === 'kiritts') {
      for (const group of request.groups.filter((g) => !g.kiriVoice)) failGroup(group, `"${group.voiceId}" is not a KiriTTS voice -- pick one of the KiriTTS voices for this line.`)
    }
    const voxGroups = request.engine === 'kiritts' ? [] : request.engine === 'edge-tts' ? request.groups.filter((g) => !!g.referenceAudioPath) : request.groups

    if (kiriGroups.length > 0) {
      const workDir = await createEdgeTtsWorkDir()
      const jobs = kiriGroups.flatMap((group) => group.segments.map((segment) => ({ voice: group.kiriVoice as string, segment })))
      let next = 0
      // A bad key, a plan without API access or used-up credits fails every
      // line the same way: stop asking after the first, report the rest.
      let fatal: string | null = null
      const worker = async (): Promise<void> => {
        while (next < jobs.length && !signal.aborted) {
          const index = next++
          const { voice, segment } = jobs[index]
          if (fatal) {
            send({ segmentId: segment.segmentId, status: 'failed', error: fatal })
            continue
          }
          const outPath = join(workDir, `kiri-${index}.wav`)
          // Acting words only when asked for (Settings: "Send emotions to
          // KiriTTS"); a thought still gets its echo afterwards either way.
          const acting = !!request.kiriActing
          const instructions = acting ? kiriInstructions(segment.performance, !!segment.innerVoice) : ''
          try {
            await kiriSpeakLine(voice, segment.text, outPath, { instructions, signal })
          } catch (err) {
            if (signal.aborted) return
            const message = err instanceof Error ? err.message : String(err)
            if (err instanceof KiriTtsError && (err.status === 401 || err.status === 403 || (err.status === 429 && /credit/i.test(message)))) fatal = message
            send({ segmentId: segment.segmentId, status: 'failed', error: message })
            continue
          }
          // A take that runs on past its words -- a tail after a pause, or
          // babble (shared/kiriTts.ts's kiriTakeVerdict): the tail is cut;
          // babble is asked for again (at most KIRI_BABBLE_RETRIES times)
          // and, if it stays, capped at what the line could need.
          const expected = kiriExpectedSeconds(segment.text)
          const cleanTake = async (path: string, tag: string): Promise<string> => {
            let current = path
            let verdict = kiriTakeVerdict(await measureSpeechSpans(current), expected)
            for (let attempt = 1; verdict.retry && attempt <= KIRI_BABBLE_RETRIES && !signal.aborted; attempt++) {
              const againPath = join(workDir, `kiri-${index}-${tag}again${attempt}.wav`)
              try {
                await kiriSpeakLine(voice, segment.text, againPath, { instructions, signal })
              } catch {
                break
              }
              const againVerdict = kiriTakeVerdict(await measureSpeechSpans(againPath), expected)
              current = againPath
              verdict = againVerdict
            }
            if (verdict.cutAt === undefined || signal.aborted) return current
            const cutPath = join(workDir, `kiri-${index}-${tag}cut.wav`)
            try {
              await cutTake(`dub-kiri-cut-${segment.segmentId}-${tag}`, current, cutPath, verdict.cutAt)
              return cutPath
            } catch {
              return current
            }
          }
          try {
            let take = await cleanTake(outPath, '')
            if (signal.aborted) return
            // Longer than its room: KiriTTS says it again, faster, itself
            // (shared/kiriTts.ts's kiriRetake) -- kept only if it really is
            // shorter. Whatever is still over is then stretched as before,
            // by far less.
            let control = instructions || null
            const speech = request.steadyPace ? 0 : await measureSpeechSeconds(`dub-kiri-measure-${segment.segmentId}`, take)
            const retake = request.steadyPace ? null : kiriRetake(speech, roomSecondsOf(segment), acting ? segment.performance : undefined, acting && !!segment.innerVoice)
            if (retake && !signal.aborted) {
              const fastPath = join(workDir, `kiri-${index}-fast.wav`)
              try {
                await kiriSpeakLine(voice, segment.text, fastPath, { ...retake, signal })
                const fastTake = await cleanTake(fastPath, 'fast')
                if ((await measureSpeechSeconds(`dub-kiri-measure-fast-${segment.segmentId}`, fastTake)) < speech - 0.05) {
                  take = fastTake
                  control = 'speed' in retake ? `speed ${retake.speed}` : retake.instructions
                }
              } catch {
                if (signal.aborted) return
                // The first take stands.
              }
            }
            await finishSegment(`dub-kiri-${segment.segmentId}`, segment, take, { voiceId: kiriVoiceId(voice), debug: { control } })
          } catch (err) {
            // A take ffmpeg cannot read (an error page saved as audio, say):
            // this line fails, the others go on.
            if (signal.aborted) return
            send({ segmentId: segment.segmentId, status: 'failed', error: `KiriTTS sent back audio that could not be used: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(KIRI_PARALLEL_LINES, jobs.length) }, worker))
    }

    if (edgeGroups.length > 0) {
      const install = validateEdgeTtsInstall(request.installDir)
      if (!install.ok) {
        for (const group of edgeGroups) {
          failGroup(group, `Edge TTS can't start -- its bundled Python is missing: ${install.missing.join(', ')}. This build may be incomplete; reinstalling the app should restore it.`)
        }
        edgeGroups.length = 0
      }
    }

    // No (or a stale) install folder in Settings -- a new machine, a moved
    // folder -- is not a reason to fail: find the install the same way the
    // Settings panel does and use it for this run.
    if (voxGroups.length > 0 && !validateVoxCpmInstall(request.installDir).ok) {
      const found = await detectVoxCpmInstalls(request.installDir)
      if (found[0]) request = { ...request, installDir: found[0] }
    }

    if (voxGroups.length > 0) {
      const install = validateVoxCpmInstall(request.installDir)
      if (!install.ok) {
        const message =
          request.engine === 'edge-tts'
            ? `This is a cloned voice, which only VoxCPM2 can speak -- but VoxCPM2 can't run from "${request.installDir}" (missing: ${install.missing.join(', ')}). Set the install folder in Settings, or pick a Khmer Male/Female voice.`
            : `VoxCPM2 can't run from "${request.installDir}" -- missing: ${install.missing.join(', ')}. Set the correct folder in Settings > AI Dubber Voice Engine.`
        for (const group of voxGroups) failGroup(group, message)
        voxGroups.length = 0
      }
    }

    if (edgeGroups.length > 0) {
      const workDir = await createEdgeTtsWorkDir()
      let lineIndex = 0
      // Lines Microsoft's service turned down in the first pass. On a long
      // run it starts refusing lines in bursts (rate limiting) -- the
      // runner's own quick retries sit inside one burst, so these get one
      // more try after a real pause, once everything else is made.
      const retryLater: Array<{ voice: string; segment: DubbingGenerationGroup['segments'][number]; outPath: string }> = []
      const speak = async (voice: string, segment: DubbingGenerationGroup['segments'][number], outPath: string, lastTry: boolean): Promise<'done' | 'failed' | 'unreadable' | 'canceled'> => {
        try {
          await runEdgeTtsLine(request.installDir, voice, segment.text, outPath, signal)
        } catch (err) {
          if (err instanceof EdgeTtsCanceledError || signal.aborted) return 'canceled'
          // Untranslated text fails the same way every time: report it now,
          // never queue it for the retry pass.
          if (lastTry || err instanceof EdgeTtsUnreadableTextError) {
            send({ segmentId: segment.segmentId, status: 'failed', error: err instanceof Error ? err.message : String(err) })
            return err instanceof EdgeTtsUnreadableTextError ? 'unreadable' : 'failed'
          }
          return 'failed'
        }
        await finishSegment(`dub-edge-${segment.segmentId}`, segment, outPath, { voiceId: voice, debug: { control: null } })
        return 'done'
      }
      edgeLoop: for (const group of edgeGroups) {
        if (signal.aborted) break
        if (!group.edgeVoice) {
          failGroup(group, `"${group.voiceId}" has no Edge TTS equivalent. Pick a Khmer Male/Female voice, or switch the engine back to VoxCPM2.`)
          continue
        }
        for (const segment of group.segments) {
          if (signal.aborted) break edgeLoop
          const outPath = edgeTtsOutputPath(workDir, lineIndex)
          lineIndex++
          const outcome = await speak(group.edgeVoice, segment, outPath, false)
          if (outcome === 'canceled') break edgeLoop
          if (outcome === 'failed') retryLater.push({ voice: group.edgeVoice, segment, outPath })
        }
      }
      if (retryLater.length > 0 && !signal.aborted) {
        await abortableDelay(EDGE_RETRY_PAUSE_MS, signal)
        for (const { voice, segment, outPath } of retryLater) {
          if (signal.aborted) break
          if ((await speak(voice, segment, outPath, true)) === 'canceled') break
        }
      }
    }

    for (const group of voxGroups) {
      if (signal.aborted) break
      if (group.voiceId === 'custom-voice' && !group.referenceAudioPath) {
        failGroup(group, 'Custom Voice has no reference recording yet. Record one, or choose an audio file, in the Voice Model panel.')
        continue
      }
      if (group.referenceAudioPath) {
        try {
          const { ok, durationSeconds } = await validateReferenceAudioDuration(group.referenceAudioPath)
          if (!ok) {
            failGroup(group, `Reference audio is ${durationSeconds.toFixed(1)}s long; VoxCPM2 cloning needs ~18s or shorter.`)
            continue
          }
        } catch (err) {
          failGroup(group, `Could not read reference audio: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
      }

      // A catalog voice (control prompt) clones from its own cached
      // reference clip so every run reproduces the same speaker -- see
      // voxcpmTts.ts's ensureVoiceReferenceClip.
      let effectiveGroup = group
      if (!group.referenceAudioPath && group.control) {
        // A picked, bundled reference (the drama voices) before minting one.
        const referenceAudioPath = bundledVoiceReferencePath(group.voiceId) ?? (await ensureVoiceReferenceClip(request.installDir, request.device, group.voiceId, group.control))
        if (referenceAudioPath) effectiveGroup = { ...group, referenceAudioPath }
      }
      if (effectiveGroup.referenceAudioPath) {
        effectiveGroup = { ...effectiveGroup, referenceAudioPath: await ensureReferenceCloneLength(effectiveGroup.referenceAudioPath) }
      }
      if (effectiveGroup.referenceAudioPath) await ensureVoiceMatcherInstalled(request.installDir)

      const texts = group.segments.map((s) => s.text)
      const jobId = `dub-batch-${group.voiceId}-${Date.now()}`

      // Per-line performance: each line that carries one gets its own
      // control (identity + performance, shared/dubbingPerformance.ts's
      // buildLineControl), its own seed (performanceSeedFor) and the
      // scoring profile the runner judges its takes by. A line without
      // one keeps the group's control and the voice's seed, as before.
      const lineJobs: RunnerLineJob[] | undefined = group.segments.some((s) => s.performance)
        ? group.segments.map((segment) => {
            if (!segment.performance) return {}
            return {
              control: buildLineControl(group.voiceDescription, segment.performance),
              seed: performanceSeedFor(group.voiceId, segment.lineKey ?? segment.segmentId, segment.takeNonce ?? 0),
              // Voice tone "Locked" = the voice over the acting: less pitch
              // room per emotion and stricter identity checks.
              profile: emotionProfile(segment.performance, { voiceLock: request.tone === 'locked' }),
              slotSeconds: roomSecondsOf(segment),
              // If every take drifts off the character's voice, one more on
              // the voice's own seed with the acting held back.
              safeControl: buildLineControl(group.voiceDescription, restrainedPerformance(segment.performance)),
              voiceSeed: voiceSeedFor(group.voiceId)
            }
          })
        : undefined
      const lineDebug = new Map<number, Partial<DubbingLineDebug>>()

      const handleSegmentDone = (index: number, outputPath: string | null): void => {
        const segment = group.segments[index]
        if (!segment) return
        if (!outputPath) {
          send({ segmentId: segment.segmentId, status: 'failed', error: 'VoxCPM2 reported this line finished but wrote no audio file for it.' })
          return
        }
        const job = lineJobs?.[index]
        void finishSegment(`${jobId}-${index}`, segment, outputPath, {
          voiceId: group.voiceId,
          // The runner's own report, else what was sent (the stock CLI
          // fallback cannot report per line).
          debug: lineDebug.get(index) ?? (job ? { control: job.control ?? null, seed: job.seed } : undefined)
        })
      }

      try {
        await runVoxCpmBatch(jobId, request.installDir, request.device, effectiveGroup, texts, handleSegmentDone, {
          pitchMatch: request.pitchMatch,
          tone: request.tone,
          signal,
          lineJobs,
          onLineDebug: (index, debug) => lineDebug.set(index, debug)
        })
      } catch (err) {
        // The whole group's process never produced anything usable at all
        // (bad install path, model failed to load) -- every segment in it
        // reports failed since none of them got their own per-line event.
        // (After Cancel, `send` drops these: an unmade line is not a failure.)
        failGroup(group, err instanceof Error ? err.message : String(err))
      }
    }
  }
}
