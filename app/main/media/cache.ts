import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'

export function getMediaCacheRoot(): string {
  return join(app.getPath('userData'), 'media-cache')
}

/** Cache key derived from path + size + mtime, so edited/replaced files are reprocessed. */
export async function cacheKeyForFile(filePath: string): Promise<string> {
  const stats = await stat(filePath)
  const hash = createHash('sha1')
  hash.update(filePath)
  hash.update(String(stats.size))
  hash.update(String(Math.trunc(stats.mtimeMs)))
  return hash.digest('hex')
}

export async function ensureCacheDir(key: string): Promise<string> {
  const dir = join(getMediaCacheRoot(), key)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
