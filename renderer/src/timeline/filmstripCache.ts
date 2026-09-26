const FRAME_TARGET_WIDTH_PX = 100
const MAX_FRAMES = 40
const MAX_CACHE_ENTRIES = 200

export interface FilmstripCacheEntry {
  frames: string[]
  /** False while extraction was cut short (the clip scrolled out of the
   * Timeline's virtualization window mid-run, say) -- the frames are still
   * good to show, there are just fewer of them than the width calls for, so
   * the next run resumes from where this one stopped instead of restarting. */
  complete: boolean
}

/** Extracted filmstrip frames, shared across every VideoFilmstrip mount for
 * the life of the session.
 *
 * The Timeline VIRTUALIZES clips (see Timeline.tsx's visibleClipsByTrackId):
 * a clip that scrolls -- or is dragged -- outside the viewport window
 * unmounts entirely, and mounts fresh when it comes back. Without this cache
 * that meant a full re-extraction (a new <video>, a decode, one seek plus one
 * JPEG encode per frame) every single time, which is what made dragging a
 * video clip visibly "refresh" its thumbnails over and over while pinning the
 * CPU. Module-level rather than component state precisely because the
 * component is the thing that keeps going away. */
const cache = new Map<string, FilmstripCacheEntry>()

/** How many frames a strip this wide is cut into. Deliberately coarse (one
 * per ~100px, capped): the frame COUNT is part of the cache key, so keying on
 * this rather than the raw pixel width means small zoom/trim adjustments that
 * don't change the count re-use the same extraction instead of redoing it. */
export function frameCountForWidth(widthPx: number): number {
  return Math.max(4, Math.min(MAX_FRAMES, Math.round(widthPx / FRAME_TARGET_WIDTH_PX)))
}

/** Everything the extracted pixels actually depend on -- source file, which
 * window of it is sampled, and how finely. Two clips of the same file showing
 * DIFFERENT trims must never share an entry, so `startOffset`/`duration` are
 * both part of the key. */
export function filmstripCacheKey(src: string, startOffset: number, duration: number, frameCount: number): string {
  return `${src}|${startOffset}|${duration}|${frameCount}`
}

export function readFilmstripCache(key: string): FilmstripCacheEntry | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  // Re-insert so it counts as most-recently-used for the eviction below --
  // Map iterates in insertion order, so deleting the first key evicts the
  // least recently touched entry.
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

export function writeFilmstripCache(key: string, entry: FilmstripCacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Test-only: the cache is module-level and deliberately survives unmounts,
 * so tests need a way back to a known-empty state. */
export function clearFilmstripCache(): void {
  cache.clear()
}

export function filmstripCacheSize(): number {
  return cache.size
}

export const FILMSTRIP_CACHE_LIMIT = MAX_CACHE_ENTRIES
