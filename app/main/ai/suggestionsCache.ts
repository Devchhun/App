import { app } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { readFile, writeFile, mkdir, rename, unlink } from 'fs/promises'
import { PROMPT_VERSION, SCHEMA_VERSION } from '@shared/suggestions'
import type { AiSuggestion } from '@shared/suggestions'
import type { SegmentInput } from './providers/AiProvider'

function cacheDir(): string {
  return join(app.getPath('userData'), 'ai-suggestions-cache')
}

/** Cache key covers everything that should invalidate a cached result if it
 * changes: the exact transcript text sent (order-independent segment
 * content), the model, and both version numbers -- so a prompt-wording
 * change or a schema change can't silently serve stale-shaped data. */
export function computeCacheKey(mediaId: string, segments: SegmentInput[], model: string): string {
  const normalized = [...segments].sort((a, b) => a.segmentId.localeCompare(b.segmentId))
  const hash = createHash('sha256')
  hash.update(mediaId)
  hash.update('|')
  hash.update(model)
  hash.update('|')
  hash.update(String(PROMPT_VERSION))
  hash.update('|')
  hash.update(String(SCHEMA_VERSION))
  for (const seg of normalized) {
    hash.update('|')
    hash.update(seg.segmentId)
    hash.update(':')
    hash.update(seg.text)
  }
  return hash.digest('hex')
}

interface CacheEntry {
  suggestions: AiSuggestion[]
  model: string
  cachedAt: string
}

export async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(join(cacheDir(), `${key}.json`), 'utf-8')
    return JSON.parse(raw) as CacheEntry
  } catch {
    return null
  }
}

export async function writeCache(key: string, suggestions: AiSuggestion[], model: string): Promise<void> {
  await mkdir(cacheDir(), { recursive: true })
  const entry: CacheEntry = { suggestions, model, cachedAt: new Date().toISOString() }
  const path = join(cacheDir(), `${key}.json`)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(entry))
  await rename(tmpPath, path)
}

export async function invalidateCache(key: string): Promise<void> {
  try {
    await unlink(join(cacheDir(), `${key}.json`))
  } catch {
    // already absent
  }
}
