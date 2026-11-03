/** Several voices saying one line together (a crowd answering, two people
 * speaking at once). The line is made once per voice -- the line's own
 * voice and up to TOGETHER_MAX_EXTRA more -- and every take is a clip of its
 * own on the Timeline, one above the other, each starting a little after
 * the first: heard as several people, not as one voice doubled, and each
 * still movable and adjustable by hand. */

/** Voices on top of the line's own. */
export const TOGETHER_MAX_EXTRA = 4

/** The id an extra voice's take travels under (`part` from 1). */
export function togetherPartId(lineId: string, part: number): string {
  return `${lineId}~together${part}`
}

/** Nobody in a crowd starts on the same instant; more than about 0.15 s
 * apart and it stops being "together". */
const DELAYS_SECONDS = [0, 0.07, 0.035, 0.11, 0.15]

/** How long after the line's own voice (part 0) an extra voice comes in. */
export function togetherDelaySeconds(part: number): number {
  return DELAYS_SECONDS[Math.max(0, Math.min(part, DELAYS_SECONDS.length - 1))]
}
