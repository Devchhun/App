import { ipcMain } from 'electron'
import { PROJECT_IPC } from '@shared/project'
import type { ProjectFile } from '@shared/project'
import { getOrCreateStartupProject, saveProjectAtomic } from '../project/projectStore'

export function registerProjectIpc(): void {
  ipcMain.handle(PROJECT_IPC.getOrCreateStartup, async () => getOrCreateStartupProject())
  ipcMain.handle(PROJECT_IPC.save, async (_event, project: ProjectFile) => saveProjectAtomic(project))
}
