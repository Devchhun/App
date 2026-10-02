export const VOCAL_REMOVAL_IPC = {
  /** Writes a vocals-cancelled ("instrumental") copy of a media file's audio
   * and returns its path, ready for the renderer's own importPaths. See
   * app/main/media/vocalRemoval.ts for how the cancellation works and what
   * it can't do. */
  removeVocals: 'vocalRemoval:remove',
  /** Main -> renderer push, one event per progress step while a removeVocals
   * call is running (same push pattern as DUBBING_IPC.generationProgress). */
  progress: 'vocalRemoval:progress',
  /** Stops a running removeVocals job (by its jobId). */
  cancel: 'vocalRemoval:cancel'
} as const

export interface VocalRemovalProgress {
  jobId: string
  /** 0-100 across the whole job (decode, separate, encode). */
  percent: number
  /** Short human label for the current step. */
  stage: string
}

export type RemoveVocalsResult = { ok: true; outputPath: string } | { ok: false; error: string; canceled?: boolean }

/** One piece of a long file's separation: the stretch of the file decoded
 * for it (`start`, `length`, seconds) and the part of its result that is
 * kept (`keepFrom`-`keepTo`, seconds into the piece). */
export interface SeparationChunk {
  start: number
  length: number
  keepFrom: number
  keepTo: number
}

/** Demucs holds a whole file in memory: 20 minutes took 9.8 GB, so a
 * feature-length video (~45 GB) overran a 32 GB machine and the job crawled
 * through the page file for hours ("Remove Vocal is stuck"). Pieces of
 * `chunkSeconds` keep it near 2-3 GB. Each piece is decoded with `overlap`
 * seconds of the neighbouring audio on both sides so the separator has
 * context at its edges; only its own stretch is kept -- plus `crossfade`/2
 * on each inner side, so neighbours blend over `crossfade` seconds and the
 * pieces add up to exactly `duration`. A short tail joins the piece before
 * it rather than being separated on its own. */
export function planSeparationChunks(duration: number, chunkSeconds = 300, overlap = 2, crossfade = 0.05): SeparationChunk[] {
  if (!(duration > 0)) return []
  let count = Math.max(1, Math.ceil(duration / chunkSeconds - 1e-9))
  if (count > 1 && duration - (count - 1) * chunkSeconds < 30) count--
  const half = crossfade / 2
  const chunks: SeparationChunk[] = []
  for (let i = 0; i < count; i++) {
    const from = i === 0 ? 0 : i * chunkSeconds - half
    const to = i === count - 1 ? duration : (i + 1) * chunkSeconds + half
    const start = Math.max(0, i * chunkSeconds - overlap)
    const end = i === count - 1 ? duration : Math.min(duration, (i + 1) * chunkSeconds + overlap)
    chunks.push({ start, length: end - start, keepFrom: from - start, keepTo: to - start })
  }
  return chunks
}
