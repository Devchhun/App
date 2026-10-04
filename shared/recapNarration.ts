// Turning a Recap Script (plain text) into something the voice engine can
// read: sentences, grouped into paragraph-sized chunks (one TTS take
// each, for continuous prosody), each with an estimated duration. The
// generated chunks are stitched into ONE continuous file afterwards --
// a recap is a single read, not a row of separate clips.

/** Khmer and Latin sentence enders. Khmer text is commonly written with
 * no space after ។, so the khan ends a line on its own; Latin enders need
 * the following whitespace (or "3.5" and "e.g." would split). A newline
 * always ends a line too. */
const SENTENCE_END = /(?<=។)\s*|(?<=[.!?؟…])\s+|\n+/u

/** Lines longer than this are split again at clause breaks (, ៖ ; :) so
 * one line never becomes a minute-long TTS take. */
const MAX_LINE_CHARS = 180
const CLAUSE_BREAK = /(?<=[,;:៖])\s+/u

/** Splits a script into voiceable lines: sentences, then over-long
 * sentences at clause breaks; blank/whitespace-only pieces dropped. */
export function splitRecapScript(text: string): string[] {
  const out: string[] = []
  for (const rawSentence of text.split(SENTENCE_END)) {
    const sentence = rawSentence.trim()
    if (!sentence) continue
    if (sentence.length <= MAX_LINE_CHARS) {
      out.push(sentence)
      continue
    }
    let buffer = ''
    for (const clause of sentence.split(CLAUSE_BREAK)) {
      const next = buffer ? `${buffer} ${clause}` : clause
      if (next.length > MAX_LINE_CHARS && buffer) {
        out.push(buffer.trim())
        buffer = clause
      } else {
        buffer = next
      }
    }
    if (buffer.trim()) out.push(buffer.trim())
  }
  return out
}

/** Groups sentences into chunks of up to `maxChars` for generation: one
 * TTS take per paragraph-sized chunk reads far more continuously than one
 * per sentence (the voice carries its rhythm across sentence ends), and
 * the chunks are stitched into one file afterwards anyway. A newline in
 * the script always ends a chunk (a paragraph break is a real pause).
 *
 * 160 chars is ~3 Khmer sentences / ~15-20 s of speech: long enough for
 * the read to flow, short enough that the model's voice hasn't drifted by
 * the end of the take (it does over ~40 s takes), and cheap to re-make
 * when one take comes out in the wrong voice. */
export function chunkRecapScript(text: string, maxChars = 160): string[] {
  const chunks: string[] = []
  for (const paragraph of text.split(/\n+/)) {
    const lines = splitRecapScript(paragraph)
    let buffer = ''
    for (const line of lines) {
      const next = buffer ? `${buffer} ${line}` : line
      if (next.length > maxChars && buffer) {
        chunks.push(buffer)
        buffer = line
      } else {
        buffer = next
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim())
  }
  return chunks
}

/** Rough speaking time. Khmer script packs more sound per character than
 * Latin, so it gets a slower per-character rate; both floor at a second
 * and change so a two-word line still gets a real slot. */
export function estimateLineSeconds(line: string): number {
  const khmerChars = (line.match(/[ក-៿]/g) ?? []).length
  const otherChars = line.replace(/\s+/g, '').length - khmerChars
  const seconds = 0.6 + khmerChars * 0.12 + otherChars * 0.075
  return Math.min(60, Math.max(1.2, seconds))
}

function srtTimestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

export interface RecapSrt {
  srtText: string
  lineCount: number
  totalSeconds: number
}

/** Lays the lines end to end from `startAt`, `gapSeconds` apart. */
export function buildRecapSrt(lines: string[], options: { startAt?: number; gapSeconds?: number } = {}): RecapSrt {
  const gap = options.gapSeconds ?? 0.35
  let cursor = options.startAt ?? 0
  const blocks: string[] = []
  lines.forEach((line, i) => {
    const duration = estimateLineSeconds(line)
    const start = cursor
    const end = start + duration
    blocks.push(`${i + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${line}\n`)
    cursor = end + gap
  })
  return { srtText: blocks.join('\n'), lineCount: lines.length, totalSeconds: Math.max(0, cursor - gap) }
}
