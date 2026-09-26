import { useCallback, useEffect, useRef, useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useProject } from '../project/ProjectContext'
import { useUiState } from '../nav/UiStateContext'
import { useConfirm } from '../ui/ConfirmDialog'
import { findBuiltinNarrator, findSavedVoice, loadSavedVoices, loadStoryNarratorVoiceId, subscribeSavedVoices, subscribeStoryNarrator } from '../dubbing/savedVoices'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from '../dubbing/voxcpmSettings'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { chunkRecapScript, estimateLineSeconds } from './recapNarration'
import type { DubbingGenerationGroupSegment } from '@shared/dubbing'

const STORAGE_PREFIX = 'cae-ai-script-v1:'
/** Fired by AiScriptPanel whenever the stored script changes, so the Recap
 * dock button (a different component) re-reads it. */
export const SCRIPT_CHANGED_EVENT = 'cae:recap-script-changed'

/** Extra silence laid between one generated chunk and the next inside the
 * stitched file. None: the stitch already tightens every pause (including
 * each take's tail) to a short spoken beat, so the paragraphs run on as
 * one continuous read. */
const CHUNK_GAP_SECONDS = 0

function readScript(projectId: string | null): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${projectId ?? 'draft'}`) ?? ''
  } catch {
    return ''
  }
}

export type RecapNarrationBlocker = 'no-script' | 'no-narrator' | 'no-engine'

export interface RecapProgress {
  /** Chunks the engine has finished (generated or failed). */
  completed: number
  total: number
  failed: number
  /** generating: the engine is voicing chunks; stitching: joining them
   * into one file; placing: importing that file and laying it down. */
  stage: 'generating' | 'stitching' | 'placing'
}

/** One-click "voice the recap", entirely its own pipeline -- nothing to do
 * with the AI Dubber workspace. The script becomes paragraph-sized chunks
 * (one TTS take each, so the voice keeps its rhythm across sentences);
 * one tagged VoxCPM2 batch clones every chunk from the chosen narrator's
 * reference clip; the finished chunks are then stitched, in script order,
 * into ONE continuous audio file that is imported and placed as a single
 * clip on a "Recap" audio track. A recap is one unbroken read, never a row
 * of separate clips. */
export function useRecapNarration(): {
  /** Why generating can't start right now, or null when it can. */
  blocker: RecapNarrationBlocker | null
  /** Number of generation chunks the script splits into. */
  lineCount: number
  narratorName: string | null
  generate: (skipConfirmation?: boolean) => Promise<void>
  cancel: () => void
  progress: RecapProgress | null
} {
  const { items, importPaths } = useMedia()
  const { sequence, insertClip, ensureTrack } = useSequence()
  const { projectId } = useProject()
  const { openSettings } = useUiState()
  const confirm = useConfirm()
  const [progress, setProgress] = useState<RecapProgress | null>(null)

  // Re-read the script / narrator whenever either changes elsewhere.
  const [, bump] = useState(0)
  useEffect(() => {
    const refresh = (): void => bump((n) => n + 1)
    window.addEventListener(SCRIPT_CHANGED_EVENT, refresh)
    const offA = subscribeStoryNarrator(refresh)
    const offB = subscribeSavedVoices(refresh)
    return () => {
      window.removeEventListener(SCRIPT_CHANGED_EVENT, refresh)
      offA()
      offB()
    }
  }, [])

  const script = readScript(projectId)
  const chunks = script.trim() ? chunkRecapScript(script) : []
  const narratorVoiceId = loadStoryNarratorVoiceId()
  // Two kinds of narrator: a saved recording (cloned by VoxCPM2, needs the
  // install folder) or a built-in Edge voice (spoken online by the app's
  // own runtime, needs nothing). The engine follows the narrator, never
  // the AI Dubber's engine setting.
  const savedNarrator = narratorVoiceId ? findSavedVoice(loadSavedVoices(), narratorVoiceId) : undefined
  const builtinNarrator = findBuiltinNarrator(narratorVoiceId)
  const narratorName = savedNarrator?.name ?? builtinNarrator?.name ?? null
  const settings = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey()))
  const engineReady = !!builtinNarrator || settings.installDir.trim().length > 0

  const blocker: RecapNarrationBlocker | null = chunks.length === 0 ? 'no-script' : !narratorName ? 'no-narrator' : !engineReady ? 'no-engine' : null

  // ---- the running batch ----
  const batchRef = useRef<{
    id: string
    /** Chunk segment ids in script order -- the stitch order. */
    order: string[]
    /** segmentId -> generated file, for every chunk the engine finished. */
    outputs: Map<string, string>
    failed: Set<string>
    /** The stitched file once it exists, waiting for the media pipeline. */
    stitchedPath: string | null
  } | null>(null)

  const fail = useCallback(
    (title: string, message: string) => {
      batchRef.current = null
      setProgress(null)
      void confirm({ title, message, confirmLabel: 'Open Settings', cancelLabel: 'Close' }).then((open) => {
        if (open) openSettings('voice')
      })
    },
    [confirm, openSettings]
  )

  /** Every chunk has been reported: join the good ones into one file. */
  const stitch = useCallback(async () => {
    const batch = batchRef.current
    if (!batch || batch.stitchedPath) return
    const paths = batch.order.filter((id) => batch.outputs.has(id)).map((id) => batch.outputs.get(id) as string)
    if (paths.length === 0) {
      fail('No narration could be generated', 'VoxCPM2 reported every part as failed. Check the install folder and device under Settings > Voice Engine.')
      return
    }
    setProgress((p) => (p ? { ...p, stage: 'stitching' } : p))
    // Levelled as a whole (true): one gain for the whole read, so no
    // paragraph comes out louder than its neighbours.
    const result = await window.api.dubbing.stitchAudio(paths, CHUNK_GAP_SECONDS, true)
    // The user may have cancelled (or a new batch started) meanwhile.
    if (batchRef.current !== batch) return
    if (!result.ok) {
      fail('Could not join the narration', `The generated parts could not be joined into one file: ${result.error}`)
      return
    }
    batch.stitchedPath = result.outputPath
    setProgress((p) => (p ? { ...p, stage: 'placing' } : p))
    void importPaths([result.outputPath])
  }, [fail, importPaths])

  // Per-chunk results from the engine, filtered to this batch by its tag.
  useEffect(() => {
    return window.api.dubbing.onGenerationProgress((event) => {
      const batch = batchRef.current
      if (!batch || event.batchId !== batch.id) return
      if (event.status === 'failed' || !event.outputPath) batch.failed.add(event.segmentId)
      else batch.outputs.set(event.segmentId, event.outputPath)
      const completed = batch.outputs.size + batch.failed.size
      setProgress((p) => (p ? { ...p, completed, failed: batch.failed.size } : p))
      if (completed >= batch.order.length) void stitch()
    })
  }, [stitch])

  // The stitched file becomes placeable once the media pipeline has it:
  // one clip, at the start of the Timeline, on its own "Recap" track.
  useEffect(() => {
    const batch = batchRef.current
    if (!batch?.stitchedPath) return
    const match = items.find((item) => item.originalPath === batch.stitchedPath)
    if (!match || (match.stage !== 'ready' && match.stage !== 'error')) return
    if (match.stage === 'error') {
      fail('Could not import the narration', 'The joined narration file could not be read back. Check the ffmpeg setup under Settings.')
      return
    }
    const start = 0
    const duration = match.metadata?.durationSeconds ?? 0
    const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
    const routing = findOrCreateTrack(sequence.tracks, occupied, start, duration, 'audio')
    if (routing.newTrack) ensureTrack({ ...routing.newTrack, name: 'Recap' })
    insertClip(assetFromMediaItem(match), start, routing.trackId)
    const skipped = batch.failed.size
    batchRef.current = null
    setProgress(null)
    if (skipped > 0) {
      void confirm({
        title: 'Narration placed with gaps',
        message: `${skipped} of ${batch.order.length} parts failed to generate and were left out of the narration. Generate again to retry.`,
        confirmLabel: 'OK',
        cancelLabel: 'Close'
      })
    }
  }, [items, sequence.clips, sequence.tracks, ensureTrack, insertClip, confirm, fail])

  const generate = useCallback(async (skipConfirmation = false) => {
    if (blocker || !narratorName || batchRef.current) return
    let cursor = 0
    const segments: DubbingGenerationGroupSegment[] = chunks.map((text, i) => {
      const startTime = cursor
      const estimate = estimateLineSeconds(text)
      // A generous slot: nothing follows a chunk in its own slot (they are
      // stitched afterwards), so the engine's auto-fit must never speed a
      // chunk up -- a recap reads at its natural pace.
      const endTime = startTime + estimate * 4
      cursor = endTime
      return { segmentId: `recap-${i}`, text, startTime, endTime, pitch: 0, speed: 1, volumeDb: 0 }
    })
    const totalSeconds = chunks.reduce((sum, text) => sum + estimateLineSeconds(text), 0) + Math.max(0, chunks.length - 1) * CHUNK_GAP_SECONDS
    const parts = `${chunks.length} ${chunks.length === 1 ? 'part' : 'parts'}`
    const engineLabel = builtinNarrator ? 'Edge TTS (online)' : 'VoxCPM2'
    if (!skipConfirmation) {
      const ok = await confirm({
        title: `Voice the recap with ${narratorName}?`,
        message: `About ${Math.round(totalSeconds)}s of continuous narration, generated with ${engineLabel} in ${narratorName}'s voice (${parts}, joined into one clip) and placed on a Recap track at the start of the Timeline.`,
        confirmLabel: 'Generate voice'
      })
      if (!ok) return
    }
    const id = `recap-${Date.now()}`
    batchRef.current = { id, order: segments.map((s) => s.segmentId), outputs: new Map(), failed: new Set(), stitchedPath: null }
    setProgress({ completed: 0, total: segments.length, failed: 0, stage: 'generating' })
    void window.api.dubbing.generateBatch(
      builtinNarrator
        ? {
            engine: 'edge-tts',
            installDir: settings.installDir,
            device: settings.device,
            batchId: id,
            groups: [{ voiceId: builtinNarrator.dubberVoiceId, edgeVoice: builtinNarrator.edgeVoice, segments }]
          }
        : {
            engine: 'voxcpm2',
            installDir: settings.installDir,
            device: settings.device,
            pitchMatch: settings.pitchMatch,
            tone: settings.tone,
            batchId: id,
            groups: [{ voiceId: narratorVoiceId ?? 'custom-voice', referenceAudioPath: savedNarrator?.referenceAudioPath, promptText: narratorName, segments }]
          }
    )
  }, [blocker, narratorName, savedNarrator, builtinNarrator, narratorVoiceId, chunks, confirm, settings.installDir, settings.device, settings.pitchMatch, settings.tone])

  const cancel = useCallback(() => {
    batchRef.current = null
    setProgress(null)
  }, [])

  return { blocker, lineCount: chunks.length, narratorName, generate, cancel, progress }
}
