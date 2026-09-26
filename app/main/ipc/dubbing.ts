import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  DUBBING_IPC,
  type DubbingGenerationRequest,
  type DubbingGenerationGroup,
  type DubbingGenerationProgressEvent,
  type PrepareReferenceClipResult,
  type RefitClipAudioResult
} from '@shared/dubbing'
import { extractDubPlaceholderClip } from '../media/dubbingAudio'
import { masterDubbingLine } from '../media/dubbingMaster'
import { stitchAudio } from '../media/audioStitch'
import {
  applyDubbingPostFx,
  computeAutoFitSpeed,
  ensureReferenceCloneLength,
  ensureVoiceMatcherInstalled,
  ensureVoiceReferenceClip,
  measureReferenceClipQuality,
  prepareReferenceClip,
  readPitchCorrection,
  runVoxCpmBatch,
  validateReferenceAudioDuration,
  validateVoxCpmInstall
} from '../media/voxcpmTts'
import { detectVoxCpmInstalls } from '../media/voxcpmDiscovery'
import { validateEdgeTtsInstall, runEdgeTtsLine, createEdgeTtsWorkDir, edgeTtsOutputPath, EdgeTtsCanceledError } from '../media/edgeTts'
import { probeMedia } from '../media/probe'

/** Running batches, keyed by their batchId (AI Dubber's own untagged batch
 * uses AI_DUBBER_BATCH). Cancel aborts the controller: loops stop starting
 * new lines, the voice process in flight is killed, and nothing further is
 * reported for the lines left unmade. */
const AI_DUBBER_BATCH = 'ai-dubber'
const runningBatches = new Map<string, AbortController>()

/** AI Dubber's main-process side: the VoxCPM2 / Edge TTS engines, the
 * Custom Voice reference-clip preparation, and the per-line audio
 * post-processing every generated line goes through. */
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
        const outputPath = await applyDubbingPostFx(args.jobId, args.sourcePath, { pitch: 0, speed: args.speed, volumeDb: 0 })
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

  ipcMain.handle(DUBBING_IPC.detectInstalls, async (_event, knownPath?: string) => detectVoxCpmInstalls(knownPath))

  ipcMain.handle(DUBBING_IPC.pickInstallFolder, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Select the VoxCPM2 installation folder', properties: ['openDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })

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
    const finishSegment = async (jobId: string, segment: DubbingGenerationGroup['segments'][number], generatedPath: string): Promise<void> => {
      try {
        // Level, de-click and trim the line FIRST (see dubbingMaster.ts) --
        // the duration the speed-fit below works from is then the speech
        // itself, not speech plus whatever dead air the model put in front.
        const rawPath = await masterDubbingLine(`${jobId}-master`, generatedPath)
        const { durationSeconds } = await probeMedia(rawPath)
        const availableSeconds =
          segment.nextSegmentStartTime !== undefined
            ? Math.max(0.1, segment.nextSegmentStartTime - segment.startTime)
            : Math.max(0.1, segment.endTime - segment.startTime)
        const autoFitSpeed = computeAutoFitSpeed(durationSeconds, availableSeconds)
        // Pitch match: nudge the take onto the reference voice's baseline
        // (see voxcpmTts.ts's computePitchCorrection) on top of whatever
        // pitch the user asked for.
        const pitchCorrection = await readPitchCorrection(generatedPath)
        const finalPath = await applyDubbingPostFx(jobId, rawPath, {
          pitch: segment.pitch + pitchCorrection,
          speed: segment.speed * autoFitSpeed,
          volumeDb: segment.volumeDb
        })
        send({ segmentId: segment.segmentId, status: 'generated', outputPath: finalPath })
      } catch (err) {
        send({ segmentId: segment.segmentId, status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }

    // A cloned voice (reference audio) is VoxCPM2's alone -- with Edge TTS
    // selected, those groups still go to VoxCPM2 while catalog voices go
    // to Edge.
    const edgeGroups = request.engine === 'edge-tts' ? request.groups.filter((g) => !g.referenceAudioPath) : []
    const voxGroups = request.engine === 'edge-tts' ? request.groups.filter((g) => !!g.referenceAudioPath) : request.groups

    if (edgeGroups.length > 0) {
      const install = validateEdgeTtsInstall(request.installDir)
      if (!install.ok) {
        for (const group of edgeGroups) {
          failGroup(group, `Edge TTS can't start -- its bundled Python is missing: ${install.missing.join(', ')}. This build may be incomplete; reinstalling the app should restore it.`)
        }
        edgeGroups.length = 0
      }
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
      for (const group of edgeGroups) {
        if (signal.aborted) break
        if (!group.edgeVoice) {
          failGroup(group, `"${group.voiceId}" has no Edge TTS equivalent. Pick a Khmer Male/Female voice, or switch the engine back to VoxCPM2.`)
          continue
        }
        for (const segment of group.segments) {
          if (signal.aborted) break
          const outPath = edgeTtsOutputPath(workDir, lineIndex)
          lineIndex++
          try {
            await runEdgeTtsLine(request.installDir, group.edgeVoice, segment.text, outPath, signal)
          } catch (err) {
            if (err instanceof EdgeTtsCanceledError || signal.aborted) break
            send({ segmentId: segment.segmentId, status: 'failed', error: err instanceof Error ? err.message : String(err) })
            continue
          }
          await finishSegment(`dub-edge-${segment.segmentId}`, segment, outPath)
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
        const referenceAudioPath = await ensureVoiceReferenceClip(request.installDir, request.device, group.voiceId, group.control)
        if (referenceAudioPath) effectiveGroup = { ...group, referenceAudioPath }
      }
      if (effectiveGroup.referenceAudioPath) {
        effectiveGroup = { ...effectiveGroup, referenceAudioPath: await ensureReferenceCloneLength(effectiveGroup.referenceAudioPath) }
      }
      if (effectiveGroup.referenceAudioPath) await ensureVoiceMatcherInstalled(request.installDir)

      const texts = group.segments.map((s) => s.text)
      const jobId = `dub-batch-${group.voiceId}-${Date.now()}`

      const handleSegmentDone = (index: number, outputPath: string | null): void => {
        const segment = group.segments[index]
        if (!segment) return
        if (!outputPath) {
          send({ segmentId: segment.segmentId, status: 'failed', error: 'VoxCPM2 reported this line finished but wrote no audio file for it.' })
          return
        }
        void finishSegment(`${jobId}-${index}`, segment, outputPath)
      }

      try {
        await runVoxCpmBatch(jobId, request.installDir, request.device, effectiveGroup, texts, handleSegmentDone, { pitchMatch: request.pitchMatch, tone: request.tone, signal })
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
