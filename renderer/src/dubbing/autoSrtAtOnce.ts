/** How many videos Auto SRT transcribes at once (Auto SRT panel's "At
 * once"), remembered on this computer. Each one reads the picture with 4
 * CPU threads or sends 3 parts to Gemini at a time, so 6 is the most
 * offered. */
export const AUTO_SRT_AT_ONCE_CHOICES = [1, 2, 3, 4, 5, 6] as const
const KEY = 'cae.autoSrtAtOnce'
const DEFAULT = 3

export function loadAutoSrtAtOnce(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return (AUTO_SRT_AT_ONCE_CHOICES as readonly number[]).includes(n) ? n : DEFAULT
  } catch {
    return DEFAULT
  }
}

export function saveAutoSrtAtOnce(n: number): void {
  try {
    localStorage.setItem(KEY, String(n))
  } catch {
    // Kept for this session only.
  }
}
