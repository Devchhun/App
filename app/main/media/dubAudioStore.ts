import { app } from 'electron'
import { existsSync } from 'fs'
import { copyFile, mkdir, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative } from 'path'

/** Where made voices live. A generated dub line is timeline media, so it
 * can't sit in the system temp folder: Windows Storage Sense empties that of
 * anything older than a day, and whole dub tracks went silent overnight. */
export function dubAudioRoot(): string {
  return join(app.getPath('userData'), 'dub-audio')
}

/** One folder per generation run, kept with the app's own data. */
export async function createDubAudioWorkDir(prefix: string): Promise<string> {
  await mkdir(dubAudioRoot(), { recursive: true })
  return mkdtemp(join(dubAudioRoot(), prefix))
}

/** A media file an older build made in the temp folder: its kept copy under
 * the dub-audio folder (same sub-path), copied there now while the temp file
 * still exists. Anything outside the temp folder, or gone from both places,
 * comes back as it was. */
export async function keepTempMedia(path: string, root?: string, temp = tmpdir()): Promise<string> {
  const rel = relative(temp, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path
  const kept = join(root ?? dubAudioRoot(), rel)
  if (existsSync(kept)) return kept
  if (!existsSync(path)) return path
  await mkdir(dirname(kept), { recursive: true })
  await copyFile(path, kept)
  return kept
}
