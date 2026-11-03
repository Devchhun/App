/** KiriTTS (https://www.kiritts.com) -- a cloud Khmer TTS with voice
 * cloning, used as the AI Dubber's third engine: nothing runs on this
 * machine, so it is light where VoxCPM2 is heavy. OpenAI-style API:
 *   POST /v1/audio/speech        {model, input, voice, response_format, speed, instructions}
 *   GET  /v1/voices              built-in Khmer voices + the account's clones
 *   POST /v1/audio/voice-clones  multipart {name, file}
 * Speech needs a plan with API access (Starter or above) -- on a lower plan
 * the server answers 403 "Your plan does not include API access", while
 * listing voices still works. */
import type { LinePerformance } from './dubbingPerformance'

export const KIRI_API_BASE = 'https://api.kiritts.com/v1'
/** What a voice says to be listened to in Detect Gender: one line, the same
 * for every voice so they compare, made once per voice and kept. */
export const KIRI_SAMPLE_TEXT = 'សួស្តី! ថ្ងៃនេះខ្ញុំសប្បាយចិត្តណាស់ ដែលបានជួបអ្នក។'
export const KIRI_MODEL = 'kiritts'
/** The server's own limit on `instructions`. */
export const KIRI_INSTRUCTIONS_MAX = 100
/** A dubbed line is far shorter, but the API's own cap is this. */
export const KIRI_INPUT_MAX = 4096
/** The voice id prefix the AI Dubber uses for a KiriTTS voice. */
export const KIRI_VOICE_PREFIX = 'kiri:'

export const KIRI_IPC = {
  hasKey: 'kiri:hasKey',
  setKey: 'kiri:setKey',
  clearKey: 'kiri:clearKey',
  listVoices: 'kiri:listVoices',
  cloneVoice: 'kiri:cloneVoice',
  /** File dialog for a clone's recording: its path, name and length. */
  pickCloneSource: 'kiri:pickCloneSource',
  /** A voice's kept sample (made the first time): a URL the app can play. */
  voiceSample: 'kiri:voiceSample'
} as const

/** Which part of a recording a clone is made from, and how. */
export interface KiriCloneOptions {
  /** Seconds into the file. */
  start?: number
  /** Seconds used (KiriTTS keeps 30 at most; ~10 is its minimum). */
  duration?: number
  /** Take the voice out of music and effects first (Demucs, run from the
   * VoxCPM2 runtime in `installDir`) -- a clone made from a drama clip
   * with its soundtrack learns the soundtrack too. */
  isolateVoice?: boolean
  installDir?: string
}

export type KiriCloneSource = { ok: true; path: string; fileName: string; durationSeconds: number } | { ok: false; canceled?: boolean; error?: string }

/** The longest and shortest recording a clone is made from. */
export const KIRI_CLONE_MAX_SECONDS = 30
export const KIRI_CLONE_MIN_SECONDS = 10

export interface KiriVoice {
  /** What `voice` is set to when speaking. */
  id: string
  name: string
  cloned: boolean
  gender: 'male' | 'female' | 'unknown'
}

export type KiriListResult = { ok: true; voices: KiriVoice[] } | { ok: false; error: string }
export type KiriCloneResult = { ok: true; voice: KiriVoice } | { ok: false; error: string; canceled?: boolean }

export function kiriVoiceId(voice: string): string {
  return `${KIRI_VOICE_PREFIX}${voice}`
}

/** The KiriTTS voice behind an AI Dubber voice id, or undefined. */
export function kiriVoiceOf(voiceId: string | undefined): string | undefined {
  return voiceId?.startsWith(KIRI_VOICE_PREFIX) ? voiceId.slice(KIRI_VOICE_PREFIX.length) : undefined
}

/** GET /v1/voices -> the voices, the account's clones first. */
export function parseKiriVoices(body: unknown): KiriVoice[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const voices: KiriVoice[] = []
  for (const item of data) {
    const v = item as { voice_id?: unknown; name?: unknown; category?: unknown; gender?: unknown }
    const id = typeof v.voice_id === 'string' ? v.voice_id : typeof v.name === 'string' ? v.name : ''
    if (!id) continue
    voices.push({
      id,
      name: typeof v.name === 'string' && v.name ? v.name : id,
      cloned: String(v.category ?? '').toLowerCase() === 'cloned',
      gender: v.gender === 'male' || v.gender === 'female' ? v.gender : 'unknown'
    })
  }
  return voices.sort((a, b) => Number(b.cloned) - Number(a.cloned))
}

/** How each emotion is asked of KiriTTS: by the DELIVERY (shouting,
 * sobbing, whispering), not by the feeling's name. Measured on a built-in
 * voice and two clones, three takes each, against the same line with no
 * guidance: "very angry, fast, harsh, forceful" (what was sent before)
 * moved the pitch by about one semitone -- heard as no anger at all --
 * while "Shouting furiously, enraged, loud and aggressive, yelling at
 * someone" raised it by 2 to 5 semitones and doubled the voice's edge, on
 * every voice. The same held for the others: a shout, a whisper (7 dB
 * quieter, lower), joy (faster, 4 to 7 semitones up), a stern or calm
 * voice (lower, slower). Clones follow less far than the built-in voices,
 * in the same direction. Instructions in Khmer and tags in the text
 * ("[angry]", "(ស្រែក)") did nothing, or were read aloud.
 * Strong first, then the milder form for a low intensity. */
const KIRI_DELIVERY: Record<Exclude<LinePerformance['emotion'], 'neutral'>, { strong: string; mild?: string }> = {
  angry: { strong: 'Shouting furiously, enraged, loud and aggressive, yelling at someone', mild: 'Annoyed, irritated, tense and clipped voice' },
  shout: { strong: 'Yelling at the top of the voice, very loud, calling out across a distance' },
  sad: { strong: 'Very sad, slow, soft, sorrowful, low voice' },
  crying: { strong: 'Crying, sobbing, voice trembling and breaking, heartbroken, slow', mild: 'Tearful, voice trembling, holding back tears, slow' },
  happy: { strong: 'Speaking with a big smile, joyful, bright and cheerful' },
  excited: { strong: 'Overjoyed, excited, cheering, bright and energetic' },
  fear: { strong: 'Terrified, panicking, trembling voice, pleading, breathless', mild: 'Nervous, uneasy, shaky and hesitant voice' },
  shocked: { strong: 'Gasping in shock, stunned disbelief, voice rising sharply' },
  serious: { strong: 'Stern, grave and firm, low steady voice, commanding' },
  calm: { strong: 'Calm, gentle and relaxed, soft warm voice, unhurried' },
  whisper: { strong: 'Whispering very quietly, secretive, breathy' }
}

/** Below this intensity an emotion is asked for in its milder form. */
const KIRI_MILD_BELOW = 40

/** A line's acting, as KiriTTS's `instructions` (100 characters at most):
 * the emotion as a delivery (KIRI_DELIVERY) and the pace -- an inner
 * thought is asked for quietly, with the feeling only named. Empty for a
 * plain neutral line. */
export function kiriInstructions(performance: LinePerformance | undefined, innerVoice = false): string {
  const pace = performance?.pace
  const paceWord = pace === 'very_fast' ? 'very fast' : pace === 'fast' ? 'fast' : pace === 'very_slow' ? 'very slow' : pace === 'slow' ? 'slow' : ''
  const quick = pace === 'fast' || pace === 'very_fast'
  const parts: string[] = []
  const emotion = performance?.emotion ?? 'neutral'
  if (innerVoice) {
    // A thought stays quiet whatever is felt: "shouting" would undo it.
    parts.push('Soft inner thought', 'quiet')
    if (emotion !== 'neutral' && emotion !== 'whisper' && emotion !== 'shout') parts.push(emotion === 'fear' ? 'afraid' : emotion)
  } else if (emotion !== 'neutral') {
    const delivery = KIRI_DELIVERY[emotion]
    const phrase = (performance?.emotionIntensity ?? 50) < KIRI_MILD_BELOW && delivery.mild ? delivery.mild : delivery.strong
    // Asked to go faster (a line over its room): the slowness goes.
    parts.push(...phrase.split(/\s*,\s*/).filter((word) => !quick || !/\b(slow|unhurried)\b/i.test(word)))
  }
  // The pace is kept whatever else has to go to stay within the limit.
  const room = KIRI_INSTRUCTIONS_MAX - (paceWord ? paceWord.length + 2 : 0)
  let text = ''
  for (const part of parts) {
    if (paceWord && part.toLowerCase() === paceWord) continue
    const next = text ? `${text}, ${part}` : part
    if (next.length > room) break
    text = next
  }
  if (!paceWord) return text
  return text ? `${text}, ${paceWord}` : paceWord
}

/** What a failed KiriTTS request means, in words a user can act on. */
export function explainKiriError(status: number, body: string): string {
  let message = ''
  try {
    message = String((JSON.parse(body) as { error?: { message?: unknown } })?.error?.message ?? '')
  } catch {
    message = body.slice(0, 200)
  }
  if (status === 401) return 'KiriTTS rejected the API key -- check it in Settings > AI API Keys.'
  if (status === 403 && /plan/i.test(message)) return 'Your KiriTTS plan does not include API access -- it needs the Starter plan or higher (kiritts.com/pricing).'
  if (status === 429 && /credit/i.test(message)) return 'KiriTTS monthly credits are used up.'
  if (status === 429) return 'KiriTTS rate limit reached -- try again in a minute.'
  return `KiriTTS error ${status}${message ? `: ${message}` : ''}`
}

/** Worth trying again after a pause (rate limit, server hiccup) -- not a
 * bad key, a plan limit or used-up credits. */
export function isRetryableKiriStatus(status: number, body: string): boolean {
  if (status === 429) return !/credit/i.test(body)
  return status >= 500
}

/** A VoxCPM2 voice copied to KiriTTS is cloned under this name, so the
 * account itself remembers which clone is which VoxCPM2 voice -- on any
 * computer, with nothing stored here. */
export const KIRI_COPY_SUFFIX = ' (VoxCPM2)'

export function kiriCopyName(voxVoiceName: string): string {
  return `${voxVoiceName.trim()}${KIRI_COPY_SUFFIX}`
}

/** The VoxCPM2 voice name a KiriTTS clone was copied from, or undefined. */
export function voxNameOfKiriCopy(kiriVoiceName: string): string | undefined {
  return kiriVoiceName.endsWith(KIRI_COPY_SUFFIX) ? kiriVoiceName.slice(0, -KIRI_COPY_SUFFIX.length) : undefined
}

/** The account's copy of a VoxCPM2 voice (by name), or undefined. */
export function findKiriCopy(voices: KiriVoice[], voxVoiceName: string): KiriVoice | undefined {
  const wanted = kiriCopyName(voxVoiceName).toLowerCase()
  return voices.find((v) => v.cloned && v.name.toLowerCase() === wanted)
}

/** What a voice is asked to read when it is copied: ~20 seconds of calm,
 * varied Khmer speech -- KiriTTS clones from about ten seconds or more. */
export const KIRI_COPY_SAMPLE_TEXT =
  'សួស្តី! ថ្ងៃនេះខ្ញុំចង់និទានរឿងមួយឲ្យអ្នកស្ដាប់។ កាលពីយូរយារណាស់មកហើយ នៅក្នុងភូមិតូចមួយ មានក្មេងប្រុសម្នាក់ដែលចូលចិត្តមើលផ្កាយនៅពេលយប់។ គាត់តែងតែសួរម្ដាយថា តើផ្កាយទាំងនោះនៅឆ្ងាយប៉ុណ្ណា? ម្ដាយញញឹម ហើយឆ្លើយថា ឆ្ងាយណាស់កូន ប៉ុន្តែបើកូនខិតខំរៀន ថ្ងៃណាមួយកូននឹងដឹងចម្លើយដោយខ្លួនឯង។'

/** KiriTTS's own `speed` range tops out here (0.7-1.2). */
export const KIRI_SPEED_MAX = 1.2

export type KiriRetake = { speed: number } | { instructions: string }

/** A KiriTTS take that runs longer than its room is asked for again, faster,
 * by KiriTTS itself: its own faster delivery stays clear, where stretching
 * the finished audio (up to 1.28x, and 1.6x once Auto-Speed was pressed on
 * top) smeared Khmer consonants -- "slurred, can't make it out". Measured
 * on a real 53-character line with 1.98 s of room: 3.04 s at speed 1
 * (still 2.38 s after a 1.28x stretch), 2.07 s at speed 1.2 (fits after a
 * 1.045x touch-up).
 * A plain line uses `speed`, which KiriTTS accepts only without
 * instructions; a line with acting (an emotion, a pace, a thought) keeps
 * its instructions and asks for a faster pace instead.
 * null: it fits, or nothing faster can be asked for. */
export function kiriRetake(speechSeconds: number, roomSeconds: number, performance: LinePerformance | undefined, innerVoice = false): KiriRetake | null {
  if (roomSeconds <= 0 || speechSeconds <= roomSeconds * 1.03) return null
  const needed = speechSeconds / roomSeconds
  const acted = innerVoice || (!!performance && (performance.emotion !== 'neutral' || performance.pace !== 'normal'))
  if (!acted) return { speed: Math.round(Math.min(KIRI_SPEED_MAX, needed) * 100) / 100 }
  const pace = performance?.pace ?? 'normal'
  if (pace === 'very_fast') return null
  // One step faster than it was asked for: a slow line first loses its
  // slowness; a normal one goes fast (very fast when far over).
  const faster = pace === 'slow' || pace === 'very_slow' ? 'normal' : pace === 'fast' || needed > 1.2 ? 'very_fast' : 'fast'
  const base = performance ?? { emotion: 'neutral' as const, emotionIntensity: 30, speakingStyle: '', pace: 'normal' as const, energy: 'medium' as const, delivery: '', pauseHints: [], emphasisWords: [], analysisSource: 'rules' as const }
  return { instructions: kiriInstructions({ ...base, pace: faster }, innerVoice) }
}

/** KiriTTS's speaking rate on real dubbing (median of 129 takes): letters
 * and signs per second, spaces and punctuation not counted. */
export const KIRI_CHARS_PER_SECOND = 12

/** About how long a line takes to say: its letters at KiriTTS's rate, but
 * at least ~0.3 s a word (a short name is never said in 0.1 s), plus a
 * pause for each break inside it -- lines joined into one take
 * ("ប៉ី...។ ប៉ី...") are said with a pause between them. */
export function kiriExpectedSeconds(text: string): number {
  const letters = [...text.replace(/[\s.,!?;:។៕…'"“”()\-]/g, '')].length
  const words = text.split(/[\s.,!?;:។៕…]+/).filter(Boolean).length
  const breaks = (text.trim().replace(/[\s.,!?;:។៕…'"]+$/, '').match(/[.!?។៕…]+/g) ?? []).length
  return Math.max(0.35, Math.max(letters / KIRI_CHARS_PER_SECOND, words * 0.3) + breaks * 0.35)
}

/** Letters of a line, as `kiriExpectedSeconds` counts them. */
export function kiriLetterCount(text: string): number {
  return [...text.replace(/[\s.,!?;:។៕…'"“”()\-]/g, '')].length
}

/** Now and then a voice stops a word early and ends cleanly -- no cut to hear
 * in the sound, the last word simply not said ("…ទាំងស្រុង" came back as
 * "…ទាំង", 21.5 letters a second from a voice whose lines run at 15.4). So a
 * take much quicker than this voice's own usual pace is suspect. Voices differ
 * too much (9.5 to 18.7 letters a second, measured) for one fixed speed; short
 * lines vary too much to judge. */
const DROPPED_WORDS_PACE = 1.3
const DROPPED_WORDS_MIN_LETTERS = 12
const PACE_SAMPLES_NEEDED = 5

export function kiriTakeMissesWords(letters: number, speechSeconds: number, voicePaces: number[]): boolean {
  if (letters < DROPPED_WORDS_MIN_LETTERS || !(speechSeconds > 0) || voicePaces.length < PACE_SAMPLES_NEEDED) return false
  const sorted = [...voicePaces].sort((x, y) => x - y)
  return letters / speechSeconds > sorted[Math.floor(sorted.length / 2)] * DROPPED_WORDS_PACE
}

/** The line closed with an end mark, for asking again: a sentence with its end
 * written is a sentence the voice has to finish. */
export function kiriWithEndMark(text: string): string {
  const clean = text.trim()
  return /[.!?។៕…]$/.test(clean) ? clean : `${clean}។`
}

/** Where a KiriTTS take's words begin, when it opens with a stray sound.
 * Measured on 71 takes from two runs: every one began at full loudness in
 * its very first hundredth of a second -- a low thump, heard as an "ss" or
 * "uh" that is not in the text -- that died away within 0.2 s, and then
 * came 0.15 to 1.3 s of silence before the words. Speech does not start
 * like that (a voice takes a moment to build up), so: sound at once, then
 * a real silence inside the first half second, then speech -- the take is
 * used from just before that speech.
 *
 * `levels`: the take's loudest sample per 10 ms, in order. Returns the
 * second to start from, or undefined when the take does not open that way. */
export function kiriLeadInEnd(levels: ArrayLike<number>): number | undefined {
  const n = levels.length
  let peak = 0
  for (let i = 0; i < n; i++) if (levels[i] > peak) peak = levels[i]
  if (n < 40 || peak <= 0) return undefined
  // Loud from the first instant (within 15 dB of the take's peak).
  if (Math.max(levels[0], levels[1], levels[2]) < peak * 0.18) return undefined
  const quiet = peak * 0.018 // 35 dB under the peak
  // The silence after the thump: a tenth of a second or more, beginning
  // within the first 0.35 s.
  let silence = -1
  for (let i = 3; i <= 35 && silence < 0; i++) {
    let run = 0
    while (i + run < n && levels[i + run] <= quiet) run++
    if (run >= 10) silence = i
  }
  if (silence < 0) return undefined
  let speech = silence
  while (speech < n && levels[speech] <= peak * 0.03) speech++
  // Nothing much after it: that was the line itself.
  if (n - speech < 30) return undefined
  return Math.max(0, speech / 100 - 0.04)
}

/** What to do with a KiriTTS take, from its sound spans (seconds of
 * speech, in order) and how long the text should take. On a very short
 * line the model often says the words and then carries on -- a burst of
 * sound after a silence ("a tail that does not follow the text"), or, now
 * and then, babble for many seconds (7 characters came back as 27 s).
 *  - fits: keep it as it is;
 *  - a tail after a pause, once the words have had their time: cut there;
 *  - babble with no pause to cut at: ask again (`retry`), and if it stays
 *    that way, `cutAt` the most the line could need. */
export function kiriTakeVerdict(spans: { start: number; end: number }[], expectedSeconds: number): { cutAt?: number; retry?: boolean } {
  if (spans.length === 0) return {}
  // Generous on purpose: a cloned voice can speak a third slower than the
  // rate the estimate assumes (one measured at 8.8 letters/s), and a slow
  // line must never lose its last words to a "tail" cut.
  const limit = expectedSeconds * 2 + 0.8
  const babble = expectedSeconds * 2.5 + 1
  const speechEnd = spans[spans.length - 1].end
  for (let i = 0; i < spans.length - 1; i++) {
    if (spans[i].end < expectedSeconds * 0.8) continue
    const gap = spans[i + 1].start - spans[i].end
    // Over the limit, after a pause, once the words have had their time;
    // or a whole second of silence and then more sound on a take that is
    // clearly too long already.
    if ((gap >= 0.45 && speechEnd > limit && spans[i].end <= limit) || (gap >= 1 && speechEnd > expectedSeconds * 1.3 + 0.5)) return { cutAt: spans[i].end + 0.08 }
  }
  return speechEnd > babble ? { retry: true, cutAt: babble } : {}
}
