import { useCallback, useEffect, useRef, useState } from 'react'
import { findKiriCopy, kiriVoiceId, voxNameOfKiriCopy, type KiriVoice } from '@shared/kiriTts'
import { VOICE_MODELS, type VoiceModel } from './voiceModels'
import { findSavedVoice, isSavedVoiceId, loadSavedVoices } from './savedVoices'

/** The last voice list fetched (the Voice Model panel fetches it when the
 * KiriTTS engine is shown, before anything is generated). */
let lastKiriVoices: KiriVoice[] = []

/** The VoxCPM2 voice's display name (catalog or saved voice). */
export function voxVoiceName(voiceId: string): string | undefined {
  if (isSavedVoiceId(voiceId)) return findSavedVoice(loadSavedVoices(), voiceId)?.name
  return VOICE_MODELS.find((v) => v.id === voiceId)?.name
}

/** The KiriTTS copy of a VoxCPM2 voice on the account, by its Kiri id
 * (see shared/kiriTts.ts's kiriCopyName) -- or undefined. */
export function kiriCopyOf(voiceId: string, voices: KiriVoice[] = lastKiriVoices): string | undefined {
  const name = voxVoiceName(voiceId)
  return name ? findKiriCopy(voices, name)?.id : undefined
}

export type KiriVoicesState =
  | { status: 'idle' | 'loading' }
  | { status: 'no-key' }
  | { status: 'ready'; voices: KiriVoice[] }
  | { status: 'error'; error: string }

function sameVoices(a: KiriVoice[], b: KiriVoice[]): boolean {
  return a.length === b.length && a.every((v, i) => v.id === b[i].id && v.name === b[i].name && v.gender === b[i].gender)
}

/** The KiriTTS voices on the user's account (built-in Khmer voices and
 * their clones), fetched when the KiriTTS engine is shown. A list fetched
 * before is shown at once and only checked again quietly -- the Detect
 * Gender review used to open on an empty list that then filled in,
 * moving the whole dialog. */
export function useKiriVoices(enabled: boolean): { state: KiriVoicesState; refresh: () => void } {
  const [state, setState] = useState<KiriVoicesState>(() => (lastKiriVoices.length > 0 ? { status: 'ready', voices: lastKiriVoices } : { status: 'idle' }))
  const checkedRef = useRef(false)
  const load = useCallback((quiet: boolean) => {
    if (!quiet) setState({ status: 'loading' })
    void (async () => {
      if (!(await window.api.kiri.hasKey())) return setState({ status: 'no-key' })
      const result = await window.api.kiri.listVoices()
      if (result.ok) {
        const unchanged = sameVoices(result.voices, lastKiriVoices)
        lastKiriVoices = result.voices
        if (!quiet || !unchanged) setState({ status: 'ready', voices: result.voices })
      } else if (!quiet) setState({ status: 'error', error: result.error })
    })()
  }, [])
  const refresh = useCallback(() => load(false), [load])
  useEffect(() => {
    if (!enabled || checkedRef.current) return
    checkedRef.current = true
    load(state.status === 'ready')
  }, [enabled, state.status, load])
  return { state, refresh }
}

/** A KiriTTS voice as a card in the Voice Model grid. */
export function kiriVoiceToModel(voice: KiriVoice): VoiceModel {
  // A copy of a VoxCPM2 catalog voice takes that voice's gender, so it
  // shows under Male/Female too (KiriTTS gives clones no gender).
  const voxName = voxNameOfKiriCopy(voice.name)
  const vox = voxName ? VOICE_MODELS.find((v) => v.name === voxName) : undefined
  const gender = voice.gender !== 'unknown' ? voice.gender : (vox?.gender ?? 'unknown')
  const genderLabel = gender === 'female' ? 'Female' : gender === 'male' ? 'Male' : 'Voice'
  return {
    id: kiriVoiceId(voice.id),
    name: voice.name,
    description: voxName ? `${vox?.description ?? 'Saved voice'} · from VoxCPM2` : voice.cloned ? 'Cloned · KiriTTS' : `${genderLabel} · KiriTTS`,
    gender,
    ageGroup: 'adult',
    category: voice.cloned ? 'custom' : 'khmer',
    avatarLetter: [...voice.name][0]?.toUpperCase() ?? 'K'
  }
}
