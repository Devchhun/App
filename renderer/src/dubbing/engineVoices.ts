import { useMemo } from 'react'
import { BUILTIN_NARRATORS, savedVoiceId } from './savedVoices'
import { useSavedVoices, savedVoiceToModel } from './useSavedVoices'
import { useKiriVoices, kiriVoiceToModel } from './useKiriVoices'
import { VOICE_MODELS, type VoiceModel } from './voiceModels'
import type { DubbingEngine } from './voxcpmSettings'

export const ENGINE_LABEL: Record<DubbingEngine, string> = { voxcpm2: 'VoxCPM2', 'edge-tts': 'Edge TTS', kiritts: 'KiriTTS' }

/** Edge TTS has exactly two Khmer voices, so in Edge mode the pickers show
 * those two by their real names instead of the VoxCPM2 catalog (whose
 * eleven cards all collapse onto these two anyway). Each card is backed by
 * the catalog voice that maps to it (savedVoices.ts's BUILTIN_NARRATORS),
 * so a line set here is still a normal catalog voice everywhere else. */
export const EDGE_VOICE_CARDS: VoiceModel[] = BUILTIN_NARRATORS.flatMap((narrator) => {
  const base = VOICE_MODELS.find((v) => v.id === narrator.dubberVoiceId)
  if (!base) return []
  return [{ ...base, name: narrator.name, description: base.gender === 'female' ? 'Female · Edge' : 'Male · Edge', avatarLetter: narrator.name[0], category: 'khmer' as const }]
})

/** Every voice an engine can speak a line in: VoxCPM2's catalog plus the
 * user's recorded voices, Edge's two Khmer voices, or the KiriTTS
 * account's voices (loaded only while `engine` is KiriTTS). */
export function useEngineVoices(engine: DubbingEngine): { voices: VoiceModel[]; loading: boolean; error: string | null } {
  const savedVoices = useSavedVoices()
  const kiri = useKiriVoices(engine === 'kiritts')
  return useMemo(() => {
    if (engine === 'edge-tts') return { voices: EDGE_VOICE_CARDS, loading: false, error: null }
    if (engine === 'kiritts') {
      if (kiri.state.status === 'ready') return { voices: kiri.state.voices.map(kiriVoiceToModel), loading: false, error: null }
      const status = kiri.state.status
      return { voices: [], loading: status === 'loading' || status === 'idle', error: kiri.state.status === 'error' ? kiri.state.error : status === 'no-key' ? 'Add your KiriTTS API key in Settings > AI API Keys.' : null }
    }
    return { voices: [...VOICE_MODELS, ...savedVoices.map((v) => savedVoiceToModel(v, savedVoiceId(v.id)))], loading: false, error: null }
  }, [engine, kiri.state, savedVoices])
}
