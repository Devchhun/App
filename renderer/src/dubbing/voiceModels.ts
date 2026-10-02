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
// Each `controlPrompt` is the old "STRICT VOICE LOCK" text. It now does one
// job only: minting the voice's cached reference clip (and it stays word for
// word, because the cache is keyed by it). Dubbed lines used to be sent the
// same lock -- including "Do not perform dialogue" -- which kept one speaker
// but also stopped every line from being acted. Each line now gets a short
// identity lock (shared/dubbingPerformance.ts's VOICE_IDENTITY_LOCK: same
// speaker, don't imitate another person -- which is what actually prevents
// the several-voices-in-one-clip problem) plus the voice's `identity` below
// plus that line's own performance.
import type { NarrationSpeaker } from '@shared/dubbing'

export type VoiceCategory = 'stock' | 'khmer' | 'drama' | 'custom'

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
  /** The voice-design instruction this voice's reference clip is MINTED
   * from (voxcpmTts.ts's ensureVoiceReferenceClip -- the clip is cached,
   * keyed by this text, so it is left exactly as it was: changing a word
   * would mint a new clip and change the voice of every project that
   * already uses it). Since per-line performances it is no longer what a
   * dubbed line is told: each line gets VOICE_IDENTITY_LOCK + `identity` +
   * its own performance (shared/dubbingPerformance.ts's buildLineControl)
   * -- without the old "Do not perform dialogue", which stopped every line
   * from being acted. Undefined only for `custom-voice`. */
  controlPrompt?: string
  /** Short description of WHO this voice is (gender, age, timbre) -- the
   * identity half of every line's control. No delivery words ("slow",
   * "steady"): how a line is delivered comes from its performance. */
  identity?: string
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
  // Khmer drama voices -- male and female roles, each reference clip
  // chosen by ear from several VoxCPM2 candidates and bundled with the app.
  {
    id: 'drama-hero',
    name: 'Drama Hero',
    description: 'តួឯកប្រុស · Warm',
    gender: 'male',
    ageGroup: 'adult',
    category: 'drama',
    avatarLetter: 'H',
    edgeVoice: 'km-KH-PisethNeural',
    identity: 'young adult Cambodian man, the male lead of a TV drama, warm clear handsome voice, smooth mid-low pitch',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-hero.wav).
    controlPrompt: 'young adult Cambodian man in his late twenties, the male lead of a TV drama, warm clear handsome voice, gentle but confident, smooth mid-low pitch, professional Khmer dubbing actor. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-heroine',
    name: 'Drama Heroine',
    description: 'តួឯកស្រី · Sweet & Playful',
    gender: 'female',
    ageGroup: 'adult',
    category: 'drama',
    avatarLetter: 'H',
    edgeVoice: 'km-KH-SreymomNeural',
    // Matches the bundled reference picked by ear (a sweet, slightly
    // coquettish young voice) -- it is part of every line's control.
    identity: 'young Cambodian woman, the female lead of a romance drama, sweet cute voice, a little coquettish and playful, soft and breathy',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-heroine.wav).
    controlPrompt: 'young Cambodian woman in her twenties, the female lead of a TV drama, sweet gentle clear voice, soft and bright, professional Khmer dubbing actress. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-young-man',
    name: 'Drama Young Man',
    description: 'មិត្តប្រុស · Lively',
    gender: 'male',
    ageGroup: 'young',
    category: 'drama',
    avatarLetter: 'Y',
    edgeVoice: 'km-KH-PisethNeural',
    identity: 'cheerful Cambodian young man around twenty, bright energetic voice, a little higher pitch',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-young-man.wav).
    controlPrompt: 'cheerful Cambodian young man around twenty, the lively best friend in a TV drama, bright energetic voice, a little higher pitch, professional Khmer dubbing actor. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-young-girl',
    name: 'Drama Young Girl',
    description: 'ប្អូនស្រី · Cute',
    gender: 'female',
    ageGroup: 'young',
    category: 'drama',
    avatarLetter: 'Y',
    edgeVoice: 'km-KH-SreymomNeural',
    identity: 'cute Cambodian girl around sixteen, light bright sweet voice',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-young-girl.wav).
    controlPrompt: 'cute Cambodian girl around sixteen, a cheerful younger sister in a TV drama, light bright sweet voice, professional Khmer dubbing actress. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-villain',
    name: 'Drama Villain',
    description: 'តួអាក្រក់ · Deep',
    gender: 'male',
    ageGroup: 'adult',
    category: 'drama',
    avatarLetter: 'V',
    edgeVoice: 'km-KH-PisethNeural',
    identity: 'Cambodian man in his forties, the villain of a TV drama, deep cold sharp voice, low pitch',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-villain.wav).
    controlPrompt: 'Cambodian man in his forties, the villain of a TV drama, deep cold sharp voice, low pitch, calm and threatening, professional Khmer dubbing actor. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-villainess',
    name: 'Drama Villainess',
    description: 'តួអាក្រក់ស្រី · Sharp',
    gender: 'female',
    ageGroup: 'adult',
    category: 'drama',
    avatarLetter: 'V',
    edgeVoice: 'km-KH-SreymomNeural',
    identity: 'Cambodian woman in her thirties, the scheming rival of a TV drama, sharp elegant cold voice',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-villainess.wav).
    controlPrompt: 'Cambodian woman in her thirties, the scheming rival of a TV drama, sharp elegant cold voice, proud and haughty, professional Khmer dubbing actress. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-father',
    name: 'Drama Father',
    description: 'ឪពុក · Mature',
    gender: 'male',
    ageGroup: 'old',
    category: 'drama',
    avatarLetter: 'F',
    edgeVoice: 'km-KH-PisethNeural',
    identity: 'Cambodian man in his fifties, a kind wise father, deep warm steady mature voice',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-father.wav).
    controlPrompt: 'Cambodian man in his fifties, a kind wise father in a TV drama, deep warm steady mature voice, professional Khmer dubbing actor. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'drama-mother',
    name: 'Drama Mother',
    description: 'ម្ដាយ · Gentle',
    gender: 'female',
    ageGroup: 'old',
    category: 'drama',
    avatarLetter: 'M',
    edgeVoice: 'km-KH-SreymomNeural',
    identity: 'Cambodian woman in her fifties, a loving mother, warm soft mature voice',
    // Used only to mint a reference where none is bundled -- the drama
    // voices ship with one picked by ear (resources/voice-refs/drama-mother.wav).
    controlPrompt: 'Cambodian woman in her fifties, a loving mother in a TV drama, warm soft mature voice, gentle and caring, professional Khmer dubbing actress. Keep the same speaker identity for the whole clip. This clip has ONE speaker and ONE voice only. Speak only the subtitle text.'
  },
  {
    id: 'male-adult',
    name: 'Male Adult',
    description: 'Deep',
    gender: 'male',
    ageGroup: 'adult',
    category: 'stock',
    avatarLetter: 'M',
    edgeVoice: 'km-KH-PisethNeural',
    identity: 'adult male Cambodian Khmer voice, clearly male, mature, deep',
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
    identity: 'adult female Cambodian Khmer voice, clearly female, warm, mature',
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
    identity: 'young male Cambodian Khmer voice, a male teenager or young adult, bright',
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
    identity: 'young female Cambodian Khmer voice, a female teenager or young adult, bright',
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
    identity: 'elderly male Cambodian Khmer voice, an old man, lower pitch, slightly rough aged tone',
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
    identity: 'elderly female Cambodian Khmer voice, an old woman, aged soft tone',
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
    identity: 'adult Khmer male narrator, warm smooth deeper tone, clear Khmer pronunciation',
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
    identity: 'adult Khmer female voice, warm smooth tone, clear Khmer pronunciation',
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
    identity: 'young Khmer girl, bright smooth feminine child tone, clear Khmer pronunciation',
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
    identity: 'elder Cambodian Khmer male storyteller, aged, wise',
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
    identity: 'strong adult male cinematic Cambodian Khmer voice, confident and powerful',
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
    identity: 'young male character voice, a boy or young male, bright and light',
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
    identity: 'young female character voice, a girl or young female, bright and light',
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
