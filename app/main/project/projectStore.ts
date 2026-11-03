import { app } from 'electron'
import { join } from 'path'
import { readFile, rename, mkdir, readdir, stat, unlink, open } from 'fs/promises'
import { existsSync } from 'fs'
import { createNewProjectFile } from '@shared/project'
import type { ProjectFile, ProjectSummary } from '@shared/project'
import { registerMediaToken } from '../media/protocol'
import { keepTempMedia } from '../media/dubAudioStore'
import { migrateProjectFile } from '@shared/projectMigration'
import { pruneEmptyTracks, usedTrackIds } from '@shared/timelineTracks'
import { reopenLinesWithLostAudio } from '@shared/dubbing'

function projectsDir(): string {
  return join(app.getPath('userData'), 'Projects')
}

function appStatePath(): string {
  return join(app.getPath('userData'), 'app-state.json')
}

interface AppState {
  lastProjectPath?: string
}

/** `damaged`: the file is there but cannot be read -- what the computer
 * losing power mid-save leaves behind (a file of the right length, full of
 * zeros). Not the same as never having had one. */
async function readAppState(): Promise<{ state: AppState; damaged: boolean }> {
  const there = existsSync(appStatePath())
  try {
    if (there) return { state: JSON.parse(await readFile(appStatePath(), 'utf-8')) as AppState, damaged: false }
  } catch {
    // There, but unreadable: reported as damaged below.
  }
  // Whatever was last written is not what is on disk any more.
  writtenLastProjectPath = undefined
  return { state: {}, damaged: there }
}

/** Every change to the projects folder takes its turn: two saves of one
 * project at the same moment would write the same temp file over each
 * other, and the second rename would find nothing to rename. */
let writeTurn: Promise<unknown> = Promise.resolve()
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = writeTurn.then(work, work)
  writeTurn = run.catch(() => undefined)
  return run
}

/** Crash-safe AND power-cut-safe: written to a temp file next to the real
 * one, pushed all the way to the disk, and only then renamed over it.
 * Without the push to disk the rename can reach the disk before the bytes
 * do -- after a power cut the "saved" file is then all zeros. */
async function replaceFileDurable(path: string, text: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmpPath, path)
}

/** Which project to reopen -- written only when it changes, so a file the
 * app depends on at launch is not rewritten with every autosave. */
let writtenLastProjectPath: string | null | undefined
async function writeAppState(state: AppState): Promise<void> {
  const next = state.lastProjectPath ?? null
  if (writtenLastProjectPath === next) return
  await mkdir(app.getPath('userData'), { recursive: true })
  await replaceFileDurable(appStatePath(), JSON.stringify(state, null, 2))
  writtenLastProjectPath = next
}

/** Each project keeps a second copy a few minutes behind it
 * (`<id>.json.bak`): the project as it was when this sitting's first save
 * came in, refreshed every BACKUP_EVERY_MS after that. It is what the
 * project is read from when its own file did not survive. */
const BACKUP_SUFFIX = '.bak'
const BACKUP_EVERY_MS = 10 * 60 * 1000

function backupPathOf(projectPath: string): string {
  return `${projectPath}${BACKUP_SUFFIX}`
}

async function parseProjectFile(path: string): Promise<ProjectFile> {
  return JSON.parse(await readFile(path, 'utf-8')) as ProjectFile
}

/** The project as saved -- or its backup, when the file itself is damaged. */
async function readProjectRaw(projectPath: string): Promise<ProjectFile> {
  try {
    return await parseProjectFile(projectPath)
  } catch (err) {
    try {
      return await parseProjectFile(backupPathOf(projectPath))
    } catch {
      throw err
    }
  }
}

/** Run before a save replaces the project's file. Only a file that still
 * reads as a project is copied: a damaged one must never take the place of
 * a good backup. */
async function keepBackup(projectPath: string): Promise<void> {
  const backup = backupPathOf(projectPath)
  try {
    const kept = await stat(backup).catch(() => null)
    if (kept && Date.now() - kept.mtimeMs < BACKUP_EVERY_MS) return
    const text = await readFile(projectPath, 'utf-8')
    JSON.parse(text)
    await replaceFileDurable(backup, text)
  } catch {
    // Nothing saved yet, or the saved file is damaged: the backup stays.
  }
}

export function saveProjectAtomic(project: ProjectFile): Promise<string> {
  return inTurn(async () => {
    await mkdir(projectsDir(), { recursive: true })
    const projectPath = join(projectsDir(), `${project.id}.json`)
    const updated: ProjectFile = { ...project, updatedAt: new Date().toISOString() }
    await keepBackup(projectPath)
    await replaceFileDurable(projectPath, JSON.stringify(updated, null, 2))
    await writeAppState({ lastProjectPath: projectPath })
    return projectPath
  })
}

export async function loadProject(projectPath: string): Promise<ProjectFile> {
  const raw = await readProjectRaw(projectPath)
  const migrated = migrateProjectFile(raw)
  // Dub lines an older build made in the temp folder, which Windows empties
  // of anything older than a day: moved over to their kept copies (copied
  // now while they still exist), so they stop going silent.
  for (const [i, m] of migrated.media.entries()) {
    const originalPath = m.originalPath && (await keepTempMedia(m.originalPath))
    const proxyPath = m.proxyPath && (await keepTempMedia(m.proxyPath))
    if (originalPath !== m.originalPath || proxyPath !== m.proxyPath) migrated.media[i] = { ...m, originalPath, proxyPath }
  }
  // Dub lines whose audio is gone for good (deleted before the copy above
  // existed) go back to "not made yet": the AI Dubber's Generate then makes
  // just those again.
  const lostMediaIds = new Set(migrated.media.filter((m) => m.originalPath && !existsSync(m.originalPath)).map((m) => m.id))
  if (lostMediaIds.size > 0 && migrated.dubbingWorkspace) {
    const sequences = [migrated.sequence, ...(migrated.dubbingWorkspace.episodes ?? []).map((e) => e.sequence)]
    const lostClipIds = new Set(sequences.flatMap((seq) => (seq?.clips ?? []).filter((c) => lostMediaIds.has(c.mediaId)).map((c) => c.id)))
    migrated.dubbingWorkspace = reopenLinesWithLostAudio(migrated.dubbingWorkspace, lostClipIds)
  }
  // See pruneEmptyTracks's own doc comment: this only ever REMOVES tracks
  // that have nothing on them, never adds -- reopening a project can only
  // shrink its track list toward what's actually in use, never grow it.
  const usedIds = usedTrackIds(migrated.sequence.clips, migrated.scenes)
  return { ...migrated, sequence: { ...migrated.sequence, tracks: pruneEmptyTracks(migrated.sequence.tracks, usedIds) } }
}

/** Trashed projects keep their file, moved under Projects/Trash, so a
 * delete from the Home screen can be undone until "Delete forever". */
function trashDir(): string {
  return join(projectsDir(), 'Trash')
}

function projectFilePath(id: string, trashed = false): string {
  // Ids are UUIDs the app minted itself; anything else never resolves to
  // a file (so a stray "../" can't reach outside the projects folder).
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Invalid project id')
  return join(trashed ? trashDir() : projectsDir(), `${id}.json`)
}

/** Reads one project file into the shape the Home screen shows. Never
 * throws for a bad file -- returns null so one corrupt project can't hide
 * the rest. A project whose file is damaged but whose backup is not is
 * still listed (and opens from the backup). */
async function summarize(filePath: string): Promise<ProjectSummary | null> {
  try {
    const [parsed, info] = await Promise.all([readProjectRaw(filePath) as Promise<Partial<ProjectFile>>, stat(filePath)])
    if (!parsed.id || typeof parsed.name !== 'string') return null
    const clips = parsed.sequence?.clips ?? []
    const durationSeconds = clips.reduce((end, c) => Math.max(end, (c.startTime ?? 0) + (c.duration ?? 0)), 0)
    const media = parsed.media ?? []
    const cover = parsed.coverPath && existsSync(parsed.coverPath) ? parsed.coverPath : undefined
    const firstThumb = cover ?? media.find((m) => m.thumbnailPath && existsSync(m.thumbnailPath))?.thumbnailPath
    return {
      id: parsed.id,
      name: parsed.name,
      createdAt: parsed.createdAt ?? info.birthtime.toISOString(),
      updatedAt: parsed.updatedAt ?? info.mtime.toISOString(),
      durationSeconds,
      clipCount: clips.length,
      mediaCount: media.length,
      thumbnailUrl: firstThumb ? registerMediaToken(firstThumb) : undefined,
      sizeBytes: info.size
    }
  } catch {
    return null
  }
}

async function listProjectFiles(dir: string): Promise<ProjectSummary[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const summaries = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => summarize(join(dir, n))))
  return summaries.filter((s): s is ProjectSummary => s !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Every project, newest edit first. */
export function listProjects(): Promise<ProjectSummary[]> {
  return listProjectFiles(projectsDir())
}

export function listTrashedProjects(): Promise<ProjectSummary[]> {
  return listProjectFiles(trashDir())
}

/** A fresh project, saved and made the one to reopen at launch. */
export async function createProject(name: string): Promise<ProjectSummary> {
  const project = createNewProjectFile(name.trim() || 'Untitled Project')
  const path = await saveProjectAtomic(project)
  const summary = await summarize(path)
  if (!summary) throw new Error('Could not read the new project back.')
  return summary
}

/** Makes `id` the project to reopen at launch (the renderer reloads to
 * load it -- see HomeScreen.tsx). */
export async function openProject(id: string): Promise<void> {
  const path = projectFilePath(id)
  if (!existsSync(path)) throw new Error('That project no longer exists.')
  await inTurn(() => writeAppState({ lastProjectPath: path }))
}

/** Renames in the file only -- never touches which project reopens. */
export async function renameProject(id: string, name: string): Promise<void> {
  const path = projectFilePath(id)
  const trimmed = name.trim()
  if (!trimmed) return
  await inTurn(async () => {
    const raw = await readProjectRaw(path)
    await replaceFileDurable(path, JSON.stringify({ ...raw, name: trimmed, updatedAt: new Date().toISOString() }, null, 2))
  })
}

export async function trashProject(id: string): Promise<void> {
  const from = projectFilePath(id)
  if (!existsSync(from)) return
  await inTurn(async () => {
    await mkdir(trashDir(), { recursive: true })
    const to = projectFilePath(id, true)
    await rename(from, to)
    await rename(backupPathOf(from), backupPathOf(to)).catch(() => undefined)
    const { state } = await readAppState()
    if (state.lastProjectPath === from) await writeAppState({})
  })
}

export async function restoreProject(id: string): Promise<void> {
  const from = projectFilePath(id, true)
  if (!existsSync(from)) return
  await inTurn(async () => {
    await mkdir(projectsDir(), { recursive: true })
    const to = projectFilePath(id)
    await rename(from, to)
    await rename(backupPathOf(from), backupPathOf(to)).catch(() => undefined)
  })
}

export async function deleteProjectForever(id: string): Promise<void> {
  const path = projectFilePath(id, true)
  await unlink(path).catch(() => undefined)
  await unlink(backupPathOf(path)).catch(() => undefined)
}

async function findStartupProject(): Promise<ProjectFile> {
  const { state, damaged } = await readAppState()
  // The note of what was open, or the project it names, did not survive
  // an unclean shutdown.
  let lost = damaged
  if (state.lastProjectPath && existsSync(state.lastProjectPath)) {
    try {
      return await loadProject(state.lastProjectPath)
    } catch {
      lost = true
    }
  }
  if (lost) {
    // Reopen the newest project that can still be read, rather than
    // quietly starting an empty one over the user's work.
    for (const summary of await listProjects()) {
      const path = projectFilePath(summary.id)
      try {
        const project = await loadProject(path)
        await inTurn(() => writeAppState({ lastProjectPath: path }))
        return project
      } catch {
        // Not this one either: the next newest.
      }
    }
  }
  const project = createNewProjectFile('Untitled Project')
  await saveProjectAtomic(project)
  return project
}

/** One answer for everyone asking at the same moment (React's development
 * double-mount asks twice): two "start a fresh project" at once made two
 * projects. */
let startupInFlight: Promise<ProjectFile> | null = null
export function getOrCreateStartupProject(): Promise<ProjectFile> {
  if (!startupInFlight) {
    startupInFlight = findStartupProject().finally(() => {
      startupInFlight = null
    })
  }
  return startupInFlight
}
