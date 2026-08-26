import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UPDATER_IPC, type UpdaterStatus } from '@shared/updater'

let wired = false

function broadcast(getMainWindow: () => BrowserWindow | null, status: UpdaterStatus): void {
  getMainWindow()?.webContents.send(UPDATER_IPC.status, status)
}

/** Wires the persistent electron-updater event listeners (checked once at
 * launch, matching before) and also broadcasts every state change to the
 * renderer over IPC, so a manual "Check for Updates" click (see
 * registerUpdaterIpc) gets live feedback instead of silence unless a
 * download happens to finish. */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged || wired) return
  wired = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast(getMainWindow, { state: 'checking' }))
  autoUpdater.on('update-available', (info) => broadcast(getMainWindow, { state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => broadcast(getMainWindow, { state: 'not-available' }))
  autoUpdater.on('download-progress', (progress) => broadcast(getMainWindow, { state: 'downloading', percent: Math.round(progress.percent) }))
  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message)
    broadcast(getMainWindow, { state: 'error', message: err.message })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcast(getMainWindow, { state: 'downloaded', version: info.version })
    const win = getMainWindow()
    const options = {
      type: 'info' as const,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: 'A new version of Creative AI Editor is ready to install.',
      detail: `Version ${info.version} has been downloaded. Restart now to install it, or it will install automatically the next time you quit.`
    }
    const showDialog = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    void showDialog.then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall()
    })
  })

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] checkForUpdates failed:', err.message)
  })
}

/** The renderer-facing "Check for Updates" button (Titlebar.tsx) and the
 * dialog's "Restart Now" both need a way to trigger updater actions on
 * demand, not just the one automatic check at launch -- registered
 * regardless of packaging state so the button can report back a clean
 * 'unsupported' status in dev instead of the call silently doing nothing. */
export function registerUpdaterIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(UPDATER_IPC.check, async () => {
    if (!app.isPackaged) {
      broadcast(getMainWindow, { state: 'unsupported' })
      return
    }
    broadcast(getMainWindow, { state: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      broadcast(getMainWindow, { state: 'error', message: (err as Error).message })
    }
  })

  ipcMain.handle(UPDATER_IPC.quitAndInstall, () => {
    autoUpdater.quitAndInstall()
  })
}
