import { Converter } from 'opencc-js/t2cn'

/** Gemini is asked for Simplified Chinese, but measured on a real episode a
 * quarter of its lines still came back in Traditional characters (現在, 帶,
 * 風...) -- more often from the separated vocals. The dubbing script, the
 * translation and the user's own reference subtitles are all Simplified, so
 * every line is put into Simplified here (OpenCC, Traditional -> mainland). */
let convert: ((text: string) => string) | null = null

const KANA = /[\u3040-\u30ff]/

/** Simplified Chinese for Chinese lines. Japanese is left alone -- its kanji
 * are not Traditional Chinese -- so a transcript with any kana at all, or one
 * detected as Japanese, is returned unchanged. */
export function toSimplifiedChinese(texts: string[], detectedLanguage?: string): string[] {
  if (/^ja/i.test(detectedLanguage ?? '') || texts.some((text) => KANA.test(text))) return texts
  convert ??= Converter({ from: 'tw', to: 'cn' })
  return texts.map((text) => (/[\u3400-\u9fff]/.test(text) ? convert!(text) : text))
}
