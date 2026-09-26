export const VOCAL_REMOVAL_IPC = {
  /** Writes a vocals-cancelled ("instrumental") copy of a media file's audio
   * and returns its path, ready for the renderer's own importPaths. See
   * app/main/media/vocalRemoval.ts for how the cancellation works and what
   * it can't do. */
  removeVocals: 'vocalRemoval:remove',
  /** Main -> renderer push, one event per progress step while a removeVocals
   * call is running (same push pattern as DUBBING_IPC.generationProgress). */
  progress: 'vocalRemoval:progress'
} as const

export interface VocalRemovalProgress {
  jobId: string
  /** 0-100 across the whole job (decode, separate, encode). */
  percent: number
  /** Short human label for the current step. */
  stage: string
}

export type RemoveVocalsResult = { ok: true; outputPath: string } | { ok: false; error: string }
