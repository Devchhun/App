import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { createNewProjectFile } from '@shared/project'
import type { ProjectFile } from '@shared/project'
import { migrateProjectFile } from '@shared/projectMigration'

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
  return migrateProjectFile(raw)
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
