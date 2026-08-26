export const UPDATER_IPC = {
  check: 'updater:check',
  quitAndInstall: 'updater:quitAndInstall',
  status: 'updater:status'
} as const

/** Broadcast to the renderer any time electron-updater's state changes, so a
 * manual "Check for Updates" click gets real feedback instead of silence
 * until (or unless) a download happens to finish. `'unsupported'` covers dev
 * mode / no publish config, where a real network check would just error. */
export type UpdaterStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported' }
