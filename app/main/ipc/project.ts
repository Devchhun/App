import { ipcMain } from 'electron'
import { PROJECT_IPC } from '@shared/project'
import type { ProjectFile } from '@shared/project'
import {
  createProject,
  deleteProjectForever,
  getOrCreateStartupProject,
  listProjects,
  listTrashedProjects,
  openProject,
  renameProject,
  restoreProject,
  saveProjectAtomic,
  trashProject
} from '../project/projectStore'

export function registerProjectIpc(): void {
  ipcMain.handle(PROJECT_IPC.getOrCreateStartup, async () => getOrCreateStartupProject())
  ipcMain.handle(PROJECT_IPC.save, async (_event, project: ProjectFile) => saveProjectAtomic(project))
  ipcMain.handle(PROJECT_IPC.list, async () => listProjects())
  ipcMain.handle(PROJECT_IPC.listTrash, async () => listTrashedProjects())
  ipcMain.handle(PROJECT_IPC.create, async (_event, name: string) => createProject(name))
  ipcMain.handle(PROJECT_IPC.open, async (_event, id: string) => openProject(id))
  ipcMain.handle(PROJECT_IPC.rename, async (_event, args: { id: string; name: string }) => renameProject(args.id, args.name))
  ipcMain.handle(PROJECT_IPC.trash, async (_event, id: string) => trashProject(id))
  ipcMain.handle(PROJECT_IPC.restore, async (_event, id: string) => restoreProject(id))
  ipcMain.handle(PROJECT_IPC.deleteForever, async (_event, id: string) => deleteProjectForever(id))
}
