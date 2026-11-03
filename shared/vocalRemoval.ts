export const VOCAL_REMOVAL_IPC = {
  /** Writes a vocals-cancelled ("instrumental") copy of a media file's audio
   * and returns its path, ready for the renderer's own importPaths. See
   * app/main/media/vocalRemoval.ts for how the cancellation works and what
   * it can't do. */
  removeVocals: 'vocalRemoval:remove',
  /** Main -> renderer push, one event per progress step while a removeVocals
   * call is running (same push pattern as DUBBING_IPC.generationProgress). */
  progress: 'vocalRemoval:progress',
  /** Remove Vocal only where they speak: as removeVocals, then the file's own
   * sound everywhere except over the given stretches of it. */
  removeVocalsAtLines: 'vocalRemoval:removeAtLines',
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

/** A stretch of a file (seconds) where a character speaks. */
export interface SpeechRange {
  start: number
  end: number
}

/** A subtitle's words run a little outside its times. */
const SPEECH_PAD_BEFORE_SECONDS = 0.15
const SPEECH_PAD_AFTER_SECONDS = 0.3
/** Lines closer than this are one stretch: the music jumping between the
 * original and the separated sound in every short pause would be heard. */
const SPEECH_JOIN_GAP_SECONDS = 0.6
/** The fade between the two sounds, each side of a stretch. */
export const SPEECH_FADE_SECONDS = 0.08

/** Where the lines fall in one video FILE: each Timeline line over each clip
 * of that file, put back in the file's own time (a clip can start partway
 * into the file and play at another speed; a line over a cut counts on both
 * sides of it), padded and joined. */
export function speechRangesInFile(
  clips: { startTime: number; duration: number; sourceIn: number; rate: number }[],
  lines: { startTime: number; endTime: number }[],
  fileSeconds = Infinity
): SpeechRange[] {
  const found: SpeechRange[] = []
  for (const clip of clips) {
    const clipEnd = clip.startTime + clip.duration
    const toFile = (t: number): number => clip.sourceIn + (t - clip.startTime) * clip.rate
    for (const line of lines) {
      const from = Math.max(line.startTime, clip.startTime)
      const to = Math.min(line.endTime, clipEnd)
      if (to <= from) continue
      found.push({ start: Math.max(0, toFile(from) - SPEECH_PAD_BEFORE_SECONDS), end: Math.min(fileSeconds, toFile(to) + SPEECH_PAD_AFTER_SECONDS) })
    }
  }
  found.sort((a, b) => a.start - b.start)
  const joined: SpeechRange[] = []
  for (const range of found) {
    const last = joined[joined.length - 1]
    if (last && range.start - last.end < SPEECH_JOIN_GAP_SECONDS) last.end = Math.max(last.end, range.end)
    else joined.push({ ...range })
  }
  // Short enough to name a file by, and the same lines give the same name.
  return joined.map((range) => ({ start: Math.round(range.start * 1000) / 1000, end: Math.round(range.end * 1000) / 1000 }))
}

/** Stereo 16-bit samples of the original (`mixed`, changed in place) with
 * the voice-free copy faded in over `ranges` (sorted, apart by more than two
 * fades). `firstFrame` is where this block starts in the file; returns the
 * range to carry on from, for the next block. */
export function mixSpeechFrames(mixed: Int16Array, voiceFree: Int16Array, firstFrame: number, sampleRate: number, ranges: SpeechRange[], cursor = 0): number {
  const frames = mixed.length / 2
  let index = cursor
  for (let f = 0; f < frames; f++) {
    const t = (firstFrame + f) / sampleRate
    while (index < ranges.length && t > ranges[index].end + SPEECH_FADE_SECONDS) index++
    if (index >= ranges.length) break
    const range = ranges[index]
    const gain = t < range.start ? (t - range.start + SPEECH_FADE_SECONDS) / SPEECH_FADE_SECONDS : t > range.end ? (range.end + SPEECH_FADE_SECONDS - t) / SPEECH_FADE_SECONDS : 1
    if (gain <= 0) continue
    const left = f * 2
    mixed[left] = Math.round(mixed[left] * (1 - gain) + voiceFree[left] * gain)
    mixed[left + 1] = Math.round(mixed[left + 1] * (1 - gain) + voiceFree[left + 1] * gain)
  }
  return index
}

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
