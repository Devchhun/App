import { useCallback, useRef, useState } from 'react'
import { KIRI_COPY_SAMPLE_TEXT, kiriCopyName } from '@shared/kiriTts'
import type { DubbingGenerationGroup } from '@shared/dubbing'
import { VOICE_MODELS } from './voiceModels'
import { findSavedVoice, isSavedVoiceId, loadSavedVoices } from './savedVoices'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from './voxcpmSettings'
import { voxVoiceName } from './useKiriVoices'

export interface CopyJob {
  index: number
  total: number
  name: string
  phase: 'speaking' | 'cloning'
}

/** VoxCPM2's request for one voice -- built exactly like a dubbing group
 * for that kind of voice (see useVoicePreview.ts). */
function voxGroup(voiceId: string, segment: DubbingGenerationGroup['segments'][number]): DubbingGenerationGroup | null {
  if (isSavedVoiceId(voiceId)) {
    const saved = findSavedVoice(loadSavedVoices(), voiceId)
    return saved ? { voiceId, referenceAudioPath: saved.referenceAudioPath, promptText: saved.name, segments: [segment] } : null
  }
  const voice = VOICE_MODELS.find((v) => v.id === voiceId)
  return voice && voice.id !== 'custom-voice' ? { voiceId, control: voice.controlPrompt, voiceDescription: voice.identity, edgeVoice: voice.edgeVoice, segments: [segment] } : null
}

/** One VoxCPM2 take, waited for: its file, or the reason it failed. */
function speakOnce(group: DubbingGenerationGroup, batchId: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const settings = parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey()))
  return new Promise((resolve) => {
    const stop = window.api.dubbing.onGenerationProgress((event) => {
      if (event.batchId !== batchId) return
      if (event.status === 'generated' && event.outputPath) {
        stop()
        resolve({ ok: true, path: event.outputPath })
      } else if (event.status === 'failed') {
        stop()
        resolve({ ok: false, error: event.error ?? 'VoxCPM2 could not speak this voice.' })
      }
    })
    void window.api.dubbing
      .generateBatch({ engine: 'voxcpm2', installDir: settings.installDir, device: settings.device, pitchMatch: settings.pitchMatch, tone: settings.tone, groups: [group], batchId })
      .catch((err: unknown) => {
        stop()
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
  })
}

/** Copy VoxCPM2 voices to KiriTTS: VoxCPM2 reads ~20 seconds in each voice
 * on this computer, and KiriTTS clones that recording under
 * "<voice> (VoxCPM2)". Lines set to that VoxCPM2 voice then speak as the
 * copy on the KiriTTS engine (dubbingPlan.ts's resolveLineVoice). */
export function useCopyVoxToKiri(onCopied: () => void): {
  job: CopyJob | null
  message: string | null
  copy: (voiceIds: string[]) => Promise<void>
  cancel: () => void
} {
  const [job, setJob] = useState<CopyJob | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const canceledRef = useRef(false)
  const batchRef = useRef<string | null>(null)

  const copy = useCallback(
    async (voiceIds: string[]) => {
      if (voiceIds.length === 0 || batchRef.current) return
      if (!parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey())).installDir.trim()) {
        setMessage('Copying needs VoxCPM2 on this computer once: set its folder in Settings > Voice Engine.')
        return
      }
      canceledRef.current = false
      setMessage(null)
      const done: string[] = []
      const failed: string[] = []
      for (let i = 0; i < voiceIds.length && !canceledRef.current; i++) {
        const name = voxVoiceName(voiceIds[i]) ?? voiceIds[i]
        setJob({ index: i + 1, total: voiceIds.length, name, phase: 'speaking' })
        const group = voxGroup(voiceIds[i], { segmentId: 'kiri-copy', text: KIRI_COPY_SAMPLE_TEXT, startTime: 0, endTime: 120, pitch: 0, speed: 1, volumeDb: 0 })
        if (!group) {
          failed.push(`${name} (no longer exists)`)
          continue
        }
        const batchId = `kiri-copy-${Date.now()}-${i}`
        batchRef.current = batchId
        const spoken = await speakOnce(group, batchId)
        if (canceledRef.current) break
        if (!spoken.ok) {
          failed.push(`${name}: ${spoken.error}`)
          continue
        }
        setJob({ index: i + 1, total: voiceIds.length, name, phase: 'cloning' })
        const cloned = await window.api.kiri.cloneVoice(kiriCopyName(name), spoken.path)
        if (cloned.ok) done.push(name)
        else {
          failed.push(`${name}: ${cloned.error}`)
          // A bad key, a plan limit or no credits fails every voice alike.
          if (/key|plan|credit|limit/i.test(cloned.error)) break
        }
      }
      batchRef.current = null
      setJob(null)
      if (done.length > 0) onCopied()
      const parts: string[] = []
      if (done.length > 0) parts.push(`Copied to KiriTTS: ${done.join(', ')}.`)
      if (failed.length > 0) parts.push(`Not copied -- ${failed.join('; ')}`)
      if (canceledRef.current) parts.push('Stopped.')
      setMessage(parts.join(' ') || null)
    },
    [onCopied]
  )

  const cancel = useCallback(() => {
    canceledRef.current = true
    if (batchRef.current) void window.api.dubbing.cancelGeneration(batchRef.current)
  }, [])

  return { job, message, copy, cancel }
}
