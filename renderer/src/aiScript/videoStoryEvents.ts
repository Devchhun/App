export const AUTO_GENERATE_RECAP_VOICE_EVENT = 'cae:auto-generate-recap-voice'
/** The Recap voice's progress (a CustomEvent, detail: RecapProgress | null),
 * from the one generator behind the header's Recap button, for the Recap
 * Script panel's own Generate button. */
export const RECAP_PROGRESS_EVENT = 'cae:recap-progress'
/** Stops that generator. */
export const CANCEL_RECAP_VOICE_EVENT = 'cae:cancel-recap-voice'

// The last progress sent, for a panel opened while the voice is being made.
let lastRecapProgress: unknown = null
export function recapProgressNow<T = import('./useRecapNarration').RecapProgress>(): T | null {
  return lastRecapProgress as T | null
}
export function publishRecapProgress(progress: unknown): void {
  lastRecapProgress = progress ?? null
  window.dispatchEvent(new CustomEvent(RECAP_PROGRESS_EVENT, { detail: progress ?? null }))
}

