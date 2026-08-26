import { extname } from 'path'
import { stat } from 'fs/promises'
import { SUPPORTED_MEDIA_EXTENSIONS } from '@shared/media'

export type ValidationResult = { ok: true } | { ok: false; error: string }

export async function validateMediaFile(filePath: string): Promise<ValidationResult> {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (!(SUPPORTED_MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      ok: false,
      error: `Unsupported file type ".${ext || '?'}". Supported: ${SUPPORTED_MEDIA_EXTENSIONS.join(', ')}`
    }
  }

  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return { ok: false, error: 'Not a file' }
    if (stats.size === 0) return { ok: false, error: 'File is empty' }
  } catch {
    return { ok: false, error: 'File not found or inaccessible' }
  }

  return { ok: true }
}
