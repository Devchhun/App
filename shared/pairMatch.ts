/**
 * Match original videos to their edited versions by EPISODE NUMBER, not file
 * order. Two folders often number things differently — the source files by
 * episode (EP45, EP46…) and the recaps by upload order (281, 282…, which can
 * be reverse episode order) — so pairing by sorted name silently matches the
 * wrong episodes. We read the episode number out of each name instead.
 */

const KHMER_DIGITS: Record<string, string> = { '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4', '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9' }

function toAsciiDigits(s: string): string {
  return s.replace(/[០-៩]/g, (d) => KHMER_DIGITS[d] ?? d)
}

/** The episode number in a file name, or null. Prefers an explicit
 * "EP 45" / "Episode 45" / "ភាគ 45"; there may be other numbers (an upload
 * index, a resolution), so a bare trailing number is only a last resort. */
export function episodeNumber(pathOrName: string): number | null {
  const base = toAsciiDigits(String(pathOrName).replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, ''))
  // \b works for the Latin labels; Khmer script has no ASCII word boundary, so
  // ភាគ/ភាគទី is matched on the keyword alone.
  const labelled = /(?:\bep|\bepisode|ភាគទី|ភាគ)\s*\.?\s*(\d{1,4})/i.exec(base)
  if (labelled) return Number(labelled[1])
  // A parenthesised number, e.g. "(Episode 45)" already caught above, or "(45)".
  const paren = /\((\d{1,4})\)/.exec(base)
  if (paren) return Number(paren[1])
  return null
}

export interface MatchedPairs {
  originals: string[]
  editeds: string[]
  /** How pairs were formed, for the UI to warn about. */
  method: 'episode' | 'order'
  /** Originals that found no edited match by episode (only when method is 'episode'). */
  unmatched: string[]
}

/**
 * Pair originals to edits. When every original and edit exposes an episode
 * number, pair by that (the reliable path). Otherwise fall back to order
 * (zipped), which the caller should flag as needing a human check.
 */
export function pairByEpisode(originals: string[], editeds: string[]): MatchedPairs {
  const oNums = originals.map(episodeNumber)
  const eNums = editeds.map(episodeNumber)
  const canMatch = oNums.every((n) => n != null) && eNums.every((n) => n != null)

  if (canMatch) {
    const edByEp = new Map<number, string>()
    editeds.forEach((e, i) => { const n = eNums[i] as number; if (!edByEp.has(n)) edByEp.set(n, e) })
    const o: string[] = []
    const ed: string[] = []
    const unmatched: string[] = []
    originals.forEach((orig, i) => {
      const match = edByEp.get(oNums[i] as number)
      if (match) { o.push(orig); ed.push(match) } else unmatched.push(orig)
    })
    if (o.length > 0) return { originals: o, editeds: ed, method: 'episode', unmatched }
  }

  // Fall back to order.
  const count = Math.min(originals.length, editeds.length)
  return { originals: originals.slice(0, count), editeds: editeds.slice(0, count), method: 'order', unmatched: [] }
}
