import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { createNewProjectFile } from '@shared/project'
import type { ProjectFile, ProjectSummary } from '@shared/project'
import { registerMediaToken } from '../media/protocol'
import { migrateProjectFile } from '@shared/projectMigration'
import { pruneEmptyTracks, usedTrackIds } from '@shared/timelineTracks'

function projectsDir(): string {
  return join(app.getPath('userData'), 'Projects')
}

function appStatePath(): string {
  return join(app.getPath('userData'), 'app-state.json')
}

interface AppState {
  lastProjectPath?: string
}

async function readAppState(): Promise<AppState> {
  try {
    return JSON.parse(await readFile(appStatePath(), 'utf-8')) as AppState
  } catch {
    return {}
  }
}

async function writeAppStateAtomic(state: AppState): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmpPath = `${appStatePath()}.tmp`
  await writeFile(tmpPath, JSON.stringify(state, null, 2))
  await rename(tmpPath, appStatePath())
}

/** Crash-safe: writes to a temp file in the same directory, then renames over the real file. */
export async function saveProjectAtomic(project: ProjectFile): Promise<string> {
  await mkdir(projectsDir(), { recursive: true })
  const projectPath = join(projectsDir(), `${project.id}.json`)
  const tmpPath = `${projectPath}.tmp`
  const updated: ProjectFile = { ...project, updatedAt: new Date().toISOString() }
  await writeFile(tmpPath, JSON.stringify(updated, null, 2))
  await rename(tmpPath, projectPath)
  await writeAppStateAtomic({ lastProjectPath: projectPath })
  return projectPath
}

export async function loadProject(projectPath: string): Promise<ProjectFile> {
  const raw = JSON.parse(await readFile(projectPath, 'utf-8')) as ProjectFile
  const migrated = migrateProjectFile(raw)
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
 * the rest. */
async function summarize(filePath: string): Promise<ProjectSummary | null> {
  try {
    const [raw, info] = await Promise.all([readFile(filePath, 'utf-8'), stat(filePath)])
    const parsed = JSON.parse(raw) as Partial<ProjectFile>
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
  await writeAppStateAtomic({ lastProjectPath: path })
}

/** Renames in the file only -- never touches which project reopens. */
export async function renameProject(id: string, name: string): Promise<void> {
  const path = projectFilePath(id)
  const raw = JSON.parse(await readFile(path, 'utf-8')) as ProjectFile
  const trimmed = name.trim()
  if (!trimmed) return
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify({ ...raw, name: trimmed, updatedAt: new Date().toISOString() }, null, 2))
  await rename(tmpPath, path)
}

export async function trashProject(id: string): Promise<void> {
  const from = projectFilePath(id)
  if (!existsSync(from)) return
  await mkdir(trashDir(), { recursive: true })
  await rename(from, projectFilePath(id, true))
  const state = await readAppState()
  if (state.lastProjectPath === from) await writeAppStateAtomic({})
}

export async function restoreProject(id: string): Promise<void> {
  const from = projectFilePath(id, true)
  if (!existsSync(from)) return
  await mkdir(projectsDir(), { recursive: true })
  await rename(from, projectFilePath(id))
}

export async function deleteProjectForever(id: string): Promise<void> {
  await unlink(projectFilePath(id, true)).catch(() => undefined)
}

export async function getOrCreateStartupProject(): Promise<ProjectFile> {
  const state = await readAppState()
  if (state.lastProjectPath && existsSync(state.lastProjectPath)) {
    try {
      return await loadProject(state.lastProjectPath)
    } catch {
      // Corrupt project file: fall through and start fresh rather than blocking launch.
    }
  }
  const project = createNewProjectFile('Untitled Project')
  await saveProjectAtomic(project)
  return project
}
