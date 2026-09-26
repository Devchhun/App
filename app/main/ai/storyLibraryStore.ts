import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { StoryLibrary, StoryLibraryEntry, StoryReferenceCharacter } from '@shared/videoStoryNarration'

/** The app-wide story library (renderer VideoStoryRecapControls): each
 * story's title and the characters the user photographed for it. A JSON
 * file in userData rather than localStorage -- a few dozen face photos
 * outgrow localStorage's few-megabyte quota, and the library is meant to
 * outlive any one project (every episode of a story reuses it). */

const FILE_NAME = 'story-library.json'
/** Generous but bounded: a library that somehow grew huge must not be
 * loaded into every recap request. */
const MAX_STORIES = 200
const MAX_CHARACTERS_PER_STORY = 60
const MAX_IMAGE_CHARS = 400_000

function libraryPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** Keeps only well-formed stories and characters -- the file may be old,
 * hand-edited or half-written. Pure, so it can be tested. */
export function sanitizeStoryLibrary(raw: unknown): StoryLibrary {
  const stories = Array.isArray((raw as { stories?: unknown })?.stories) ? ((raw as { stories: unknown[] }).stories) : []
  const clean: StoryLibraryEntry[] = []
  for (const item of stories.slice(0, MAX_STORIES)) {
    const story = (item ?? {}) as Record<string, unknown>
    const id = text(story.id, 80)
    if (!id) continue
    const characters: StoryReferenceCharacter[] = (Array.isArray(story.characters) ? story.characters : [])
      .slice(0, MAX_CHARACTERS_PER_STORY)
      .flatMap((c) => {
        const character = (c ?? {}) as Record<string, unknown>
        const characterId = text(character.id, 80)
        if (!characterId) return []
        const image = typeof character.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(character.image) && character.image.length <= MAX_IMAGE_CHARS ? character.image : ''
        return [{ id: characterId, name: text(character.name), image }]
      })
    clean.push({ id, title: text(story.title), characters, updatedAt: text(story.updatedAt, 40) || new Date(0).toISOString() })
  }
  return { stories: clean }
}

export async function loadStoryLibrary(): Promise<StoryLibrary> {
  try {
    return sanitizeStoryLibrary(JSON.parse(await readFile(libraryPath(), 'utf8')))
  } catch {
    return { stories: [] }
  }
}

/** Written to a temp file and renamed over the old one, so a crash mid-
 * write never leaves a half-written library. */
export async function saveStoryLibrary(library: unknown): Promise<StoryLibrary> {
  const clean = sanitizeStoryLibrary(library)
  await mkdir(app.getPath('userData'), { recursive: true })
  const path = libraryPath()
  const temp = `${path}.tmp`
  await writeFile(temp, JSON.stringify(clean), 'utf8')
  await rename(temp, path)
  return clean
}
