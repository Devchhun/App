import { kiriVoiceOf } from '@shared/kiriTts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DubbingEngine, DubbingGenerationGroup } from '@shared/dubbing'
import type { VoiceModel } from './voiceModels'
import { findSavedVoice, isSavedVoiceId, loadSavedVoices } from './savedVoices'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from './voxcpmSettings'

/** The line a voice is tested with when the box is left empty. */
export const DEFAULT_VOICE_TEST_TEXT = 'សួស្តី! ថ្ងៃនេះខ្ញុំសប្បាយចិត្តណាស់ ដែលបានជួបអ្នក។ តើអ្នកសុខសប្បាយជាទេ?'

export interface VoicePreviewState {
  voiceId: string
  status: 'generating' | 'playing' | 'error'
  error?: string
}

/** Voice Model panel's "test this voice": the text spoken in one voice,
 * through the same engine and pipeline as real dubbing (so what is heard is
 * what a line will sound like), then played. Results are kept for the
 * session -- the same voice + text + engine plays again at once. */
export function useVoicePreview(options: { customVoiceReferenceAudioPath?: string; customVoiceReferenceText?: string }): {
  preview: VoicePreviewState | null
  play: (voice: VoiceModel, text: string, engine: DubbingEngine) => void
  stop: () => void
} {
  const [preview, setPreview] = useState<VoicePreviewState | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cacheRef = useRef(new Map<string, string>())
  const pendingRef = useRef<{ batchId: string; key: string; voiceId: string } | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  /** Bumped by every play and stop: a play() that settles after a newer
   * play or a Stop is not reported (pausing it rejects with AbortError). */
  const playTokenRef = useRef(0)

  const playUrl = useCallback((voiceId: string, url: string) => {
    if (!audioRef.current) audioRef.current = new Audio()
    const audio = audioRef.current
    const token = ++playTokenRef.current
    audio.onended = () => {
      if (playTokenRef.current === token) setPreview(null)
    }
    audio.src = url
    setPreview({ voiceId, status: 'playing' })
    void audio.play().catch((err: unknown) => {
      if (playTokenRef.current !== token || (err instanceof DOMException && err.name === 'AbortError')) return
      setPreview({ voiceId, status: 'error', error: 'Could not play the test audio.' })
    })
  }, [])

  useEffect(
    () =>
      window.api.dubbing.onGenerationProgress((event) => {
        const pending = pendingRef.current
        if (!pending || event.batchId !== pending.batchId) return
        pendingRef.current = null
        if (event.status !== 'generated' || !event.outputPath) {
          setPreview({ voiceId: pending.voiceId, status: 'error', error: event.error ?? 'The voice could not be generated.' })
          return
        }
        void window.api.dubbing.audioUrl(event.outputPath).then((url) => {
          if (!url) {
            setPreview({ voiceId: pending.voiceId, status: 'error', error: 'The test audio file is missing.' })
            return
          }
          cacheRef.current.set(pending.key, url)
          playUrl(pending.voiceId, url)
        })
      }),
    [playUrl]
  )

  const stop = useCallback(() => {
    playTokenRef.current++
    audioRef.current?.pause()
    if (pendingRef.current) void window.api.dubbing.cancelGeneration(pendingRef.current.batchId)
    pendingRef.current = null
    setPreview(null)
  }, [])

  const play = useCallback(
    (voice: VoiceModel, rawText: string, engine: DubbingEngine) => {
      const text = rawText.trim() || DEFAULT_VOICE_TEST_TEXT
      playTokenRef.current++
      audioRef.current?.pause()
      const key = `${engine}|${voice.id}|${text}`
      const cached = cacheRef.current.get(key)
      if (cached) {
        playUrl(voice.id, cached)
        return
      }
      if (pendingRef.current) void window.api.dubbing.cancelGeneration(pendingRef.current.batchId)
      const settings = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey()))
      const segment = { segmentId: 'voice-test', text, startTime: 0, endTime: 60, pitch: 0, speed: 1, volumeDb: 0 }
      // Built exactly like a real dubbing group for this kind of voice.
      let group: DubbingGenerationGroup
      if (isSavedVoiceId(voice.id)) {
        const saved = findSavedVoice(loadSavedVoices(), voice.id)
        if (!saved) {
          setPreview({ voiceId: voice.id, status: 'error', error: 'This saved voice no longer exists.' })
          return
        }
        group = { voiceId: voice.id, referenceAudioPath: saved.referenceAudioPath, promptText: saved.name, segments: [segment] }
      } else if (voice.id === 'custom-voice') {
        const ref = optionsRef.current.customVoiceReferenceAudioPath
        if (!ref) {
          setPreview({ voiceId: voice.id, status: 'error', error: 'Add a recording in Custom Voice first.' })
          return
        }
        group = { voiceId: voice.id, referenceAudioPath: ref, promptText: optionsRef.current.customVoiceReferenceText, segments: [segment] }
      } else {
        group = { voiceId: voice.id, control: voice.controlPrompt, voiceDescription: voice.identity, edgeVoice: voice.edgeVoice, kiriVoice: kiriVoiceOf(voice.id), segments: [segment] }
      }
      const batchId = `voice-test-${Date.now()}`
      pendingRef.current = { batchId, key, voiceId: voice.id }
      setPreview({ voiceId: voice.id, status: 'generating' })
      void window.api.dubbing
        .generateBatch({ engine, installDir: settings.installDir, device: settings.device, pitchMatch: settings.pitchMatch, tone: settings.tone, groups: [group], batchId })
        .catch((err: unknown) => {
          if (pendingRef.current?.batchId !== batchId) return
          pendingRef.current = null
          setPreview({ voiceId: voice.id, status: 'error', error: err instanceof Error ? err.message : String(err) })
        })
    },
    [playUrl]
  )

  useEffect(() => () => audioRef.current?.pause(), [])

  return { preview, play, stop }
}
