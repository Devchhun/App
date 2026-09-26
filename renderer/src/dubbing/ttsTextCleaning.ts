// Strips bracketed/parenthetical annotations (sound-effect or speaker notes
// like "(laughs)", "[music]", full-width "（説明）") from subtitle text
// before it's sent to VoxCPM2 -- otherwise the TTS engine reads them aloud
// literally, since it has no concept of "this part is a stage direction, not
// dialogue." Only ever applied to the COPY of the text handed to VoxCPM2
// (see AiDubberContext.generateDubbing) -- the subtitle's own displayed
// text/editedText is never touched by this.
const BRACKETED_RE = /[([（【][^)\]）】]*[)\]）】]/g

export function cleanTextForSpeech(text: string): string {
  return text
    .replace(BRACKETED_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether a subtitle has anything to say once cleaned: at least one letter
 * or digit in any script. Lines like "♪♪", "…", "—" or "[Music]" have
 * nothing to speak -- a voice engine given one returns no audio (Edge TTS
 * fails the line outright), so they are left out of generation instead. */
export function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(cleanTextForSpeech(text))
}
