// AI Dubber's Voice Model catalog -- a static, renderer-only list (not
// needed by the main process/export, unlike shared/dubbing.ts's persisted
// workspace state). Each entry now backs a REAL voice: `controlPrompt` is
// the free-text voice-design instruction sent to VoxCPM2's `--control` flag
// (see app/main/media/voxcpmTts.ts's buildBatchArgs) -- VoxCPM2 is steerable
// by natural-language description, not a fixed preset id, so this is just a
// tuned English sentence per catalog entry, not a lookup key into anything
// VoxCPM2-side. `custom-voice` has no `controlPrompt` at all -- it clones a
// real reference recording instead (see `referenceAudioPath`/
// `referenceText`, set via VoiceModelPanel.tsx's own file picker).
//
// Every prompt is a "STRICT VOICE LOCK" -- the voice named outright, the
// wrong readings ruled out explicitly ("clearly male... not female, not a
// child"), and then a block forbidding the model from acting: ONE speaker,
// no dialogue, no imitating other characters, no extra voices. That shape is
// lifted from the user's own rvc_gui.py, which drives this same model and
// does hold a single character's voice across a whole script. Plain
// descriptive prompts ("a deep, confident adult male voice") do not: given a
// subtitle line that reads like dialogue, VoxCPM2 will happily PERFORM it in
// several character voices inside one clip, which is what "it keeps speaking
// as many characters" was. The lock is sent alongside the cloned reference
// clip, not instead of it -- the reference pins who is speaking, the lock
// stops the model putting on voices (see voxcpmTts.ts's buildBatchArgs).
import type { NarrationSpeaker } from '@shared/dubbing'

export type VoiceCategory = 'stock' | 'khmer' | 'custom'

export interface VoiceModel {
  id: string
  name: string
  description: string
  gender: NarrationSpeaker
  ageGroup: 'young' | 'adult' | 'old'
  category: VoiceCategory
  /** Single letter shown in the card's circular avatar. */
  avatarLetter: string
  /** The matching Microsoft Edge TTS voice, used when the Edge engine is
   * selected (see shared/dubbing.ts's DubbingEngine). Khmer is the only
   * language Edge is wired up for here, so every entry maps to one of its
   * two km-KH voices by gender; 'custom-voice' has none, since Edge cannot
   * clone a reference recording. */
  edgeVoice?: string
  /** VoxCPM2's `--control` voice-design instruction -- undefined only for
   * `custom-voice`, which clones a reference recording instead. */
  controlPrompt?: string
}

/* A voice that IS a recording -- Custom Voice, every saved voice -- is sent
   with its reference clip and NO control text. This was tried the other
   way and measured on the real model with a user's own recording, six
   different lines each: no control -> 36 Hz pitch spread; the same "ONE
   speaker, no dialogue" lock the catalog voices carry -> 161 Hz, with two
   lines coming back as near-silence. A catalog voice's lock describes the
   same voice its reference was minted from, so the two agree; against a
   real recording the text is just a competing voice-design instruction
   that fights the clip. The reference alone is the whole instruction. */

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: 'male-adult',
    name: 'Male Adult',
    description: 'Deep',
    gender: 'male',
    ageGroup: 'adult',
    category: 'stock',
    avatarLetter: 'M',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Male Adult. adult male Cambodian Khmer voice, clearly male, mature, deep, not female, not a child. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'female-adult',
    name: 'Female Adult',
    description: 'Natural',
    gender: 'female',
    ageGroup: 'adult',
    category: 'stock',
    avatarLetter: 'F',
    edgeVoice: 'km-KH-SreymomNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Female Adult. adult female Cambodian Khmer voice, clearly female, warm, mature, not male, not a child. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'male-young',
    name: 'Male Young',
    description: 'Bright',
    gender: 'male',
    ageGroup: 'young',
    category: 'stock',
    avatarLetter: 'M',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Male Young. young male Cambodian Khmer voice, clearly a male teenager or young adult, bright, not female, not old. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'female-young',
    name: 'Female Young',
    description: 'Soft',
    gender: 'female',
    ageGroup: 'young',
    category: 'stock',
    avatarLetter: 'F',
    edgeVoice: 'km-KH-SreymomNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Female Young. young female Cambodian Khmer voice, clearly a female teenager or young adult, bright, not male, not old. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'male-old',
    name: 'Male Old',
    description: 'Wise',
    gender: 'male',
    ageGroup: 'old',
    category: 'stock',
    avatarLetter: 'M',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Male Old. elderly male Cambodian Khmer grandfather voice, clearly an old male, lower pitch, slightly rough aged tone, slow and steady, not female, not young. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'female-old',
    name: 'Female Old',
    description: 'Calm',
    gender: 'female',
    ageGroup: 'old',
    category: 'stock',
    avatarLetter: 'F',
    edgeVoice: 'km-KH-SreymomNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Female Old. elderly female Cambodian Khmer grandmother voice, clearly an old female, aged soft tone, slow and steady, not male, not young. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'khmer-narrator',
    name: 'Khmer Narrator',
    description: 'Clear Khmer',
    gender: 'male',
    ageGroup: 'adult',
    category: 'khmer',
    avatarLetter: 'K',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Khmer Narrator. adult Khmer male narrator, clearly male, warm smooth deeper tone, clear natural Cambodian Khmer pronunciation, not female, not a child. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'khmer-female',
    name: 'Khmer Female',
    description: 'Warm Khmer',
    gender: 'female',
    ageGroup: 'adult',
    category: 'khmer',
    avatarLetter: 'K',
    edgeVoice: 'km-KH-SreymomNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Khmer Female. adult Khmer female speaker, clearly female, warm smooth tone, clear natural Cambodian Khmer pronunciation, not male, not a child. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'khmer-young',
    name: 'Khmer Young',
    description: 'Soft Bright',
    gender: 'female',
    ageGroup: 'young',
    category: 'khmer',
    avatarLetter: 'K',
    edgeVoice: 'km-KH-SreymomNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Khmer Young. young Khmer female child speaker, clearly a girl, bright smooth feminine child tone, clear natural Cambodian Khmer pronunciation, not male, not elderly. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'khmer-elder',
    name: 'Khmer Elder',
    description: 'Story Voice',
    gender: 'male',
    ageGroup: 'old',
    category: 'khmer',
    avatarLetter: 'K',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Khmer Elder. elder Cambodian Khmer storyteller, clearly an aged elder male, wise, slow and steady, not female, not young. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'movie-hero',
    name: 'Movie Hero',
    description: 'Strong Cinema',
    gender: 'male',
    ageGroup: 'adult',
    category: 'stock',
    avatarLetter: 'H',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Movie Hero. strong adult male cinematic Cambodian Khmer voice, clearly male, confident and powerful, not female, not a child. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'anime-boy',
    name: 'Anime Boy',
    description: 'Light Character',
    gender: 'male',
    ageGroup: 'young',
    category: 'stock',
    avatarLetter: 'A',
    edgeVoice: 'km-KH-PisethNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Anime Boy. young male character voice, clearly a boy or young male, playful and expressive, not female, not old. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'anime-girl',
    name: 'Anime Girl',
    description: 'Cute Character',
    gender: 'female',
    ageGroup: 'young',
    category: 'stock',
    avatarLetter: 'A',
    edgeVoice: 'km-KH-SreymomNeural',
    controlPrompt:
      'STRICT VOICE LOCK: use exactly Anime Girl. young female character voice, clearly a girl or young female, playful and expressive, not male, not old. Keep the same speaker identity for the whole clip. Do not switch gender, age, or character style. This clip has ONE speaker and ONE voice only. Do not perform dialogue. Do not imitate any other character. Do not add another voice. Speak only the subtitle text.'
  },
  {
    id: 'custom-voice',
    name: 'Custom Voice',
    description: 'Clone Your Voice',
    gender: 'unknown',
    ageGroup: 'adult',
    category: 'custom',
    avatarLetter: 'C'
    // No controlPrompt -- see referenceAudioPath/referenceText on
    // DubbingWorkspaceState instead, set via VoiceModelPanel.tsx's picker.
  }
]

/** Right after Auto Detect Gender runs for a subtitle, this picks the voice
 * MATCHING what was detected -- Male -> the male voice, Female -> the female
 * voice; 'unknown' recommends nothing, leaving the row for the user to pick
 * manually rather than guessing. Deliberately deterministic: the same
 * detection always yields the same voice, so a line shown as "Male Adult"
 * is generated as Male Adult, never silently swapped for a different
 * catalog entry. Two same-gender characters are told apart by picking each
 * one's voice in the Detect Gender review, not by any automatic variation. */
/** The catalog voice Edge TTS speaks a line with when the line's own
 * voice is a recording it cannot clone: Edge's Khmer female for a
 * detected female speaker, its Khmer male narrator otherwise. */
export function edgeFallbackVoiceId(gender: NarrationSpeaker): string {
  return gender === 'female' ? 'khmer-female' : 'khmer-narrator'
}

export function recommendVoiceId(gender: NarrationSpeaker): string | undefined {
  if (gender === 'male') return 'male-adult'
  if (gender === 'female') return 'female-adult'
  return undefined
}
