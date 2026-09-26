import { useEffect, useState } from 'react'
import { loadSavedVoices, subscribeSavedVoices, type SavedCustomVoice } from './savedVoices'
import type { VoiceModel } from './voiceModels'

/** The user's recorded voices, kept in sync across every panel that can pick
 * one. Re-reads whenever any panel saves or deletes (see savedVoices.ts's
 * subscribe/notify) -- without this, saving a voice in the Custom Voice
 * section left the Voice Model grid and the Detect Gender review still
 * showing the old list until a reload. */
export function useSavedVoices(): SavedCustomVoice[] {
  const [voices, setVoices] = useState<SavedCustomVoice[]>(() => loadSavedVoices())
  useEffect(() => subscribeSavedVoices(setVoices), [])
  return voices
}

/** Presents a saved voice in the same shape as a catalog entry, so the
 * pickers can render it with their existing card/button markup instead of
 * each growing a parallel code path for "the other kind of voice".
 *
 * Gender is 'unknown' on purpose: nothing measured it. That keeps a recorded
 * voice out of the Male/Female filter tabs (where it would be a guess) while
 * still showing under All and Custom. */
export function savedVoiceToModel(voice: SavedCustomVoice, id: string): VoiceModel {
  return {
    id,
    name: voice.name,
    description: 'Your recording',
    gender: 'unknown',
    ageGroup: 'adult',
    category: 'custom',
    avatarLetter: voice.name.trim().charAt(0).toUpperCase() || 'C'
  }
}
