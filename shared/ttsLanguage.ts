/** Can a voice read this text at all? Measured with Edge TTS's Khmer voices
 * (km-KH-PisethNeural): a line in Chinese comes back with NO audio
 * (NoAudioReceived) every time, however often it is retried -- while
 * Khmer, English, digits and even Khmer mixed with a few Chinese words are
 * read fine. That is what an untranslated subtitle in a Chinese drama looks
 * like to the dubber, and it used to be reported as "Microsoft is busy"
 * after ~25 s of pointless retries per line. */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ᄀ-ᇿ㄰-㆏]/u
const HAN = /[㐀-䶿一-鿿豈-﫿]/u
const KANA = /[぀-ヿ]/u
const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/u

export type UnreadableScript = 'Chinese' | 'Japanese' | 'Korean'

/** The script a line is written in when a voice of `voiceLanguage` cannot
 * read it: the line has Chinese/Japanese/Korean characters and nothing else
 * the voice could speak (no letters of another script, no digits). null
 * when the line is readable -- including mixed lines, which the voice reads
 * the readable part of. Only for Khmer and English voices; others (e.g. a
 * Chinese voice) read CJK themselves. */
export function unreadableScriptFor(text: string, voiceLanguage: string): UnreadableScript | null {
  const lang = voiceLanguage.toLowerCase()
  if (!lang.startsWith('km') && !lang.startsWith('en')) return null
  if (!CJK.test(text)) return null
  const rest = text.replace(new RegExp(CJK.source, 'gu'), '')
  if (/[\p{L}\p{N}]/u.test(rest)) return null
  if (KANA.test(text)) return 'Japanese'
  if (HANGUL.test(text) && !HAN.test(text)) return 'Korean'
  return 'Chinese'
}

/** The language part of an Edge voice name ("km-KH-PisethNeural" -> "km"). */
export function voiceLanguageOf(voice: string): string {
  return voice.split('-')[0] ?? ''
}
