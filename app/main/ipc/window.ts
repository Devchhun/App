import { ipcMain, type BrowserWindow } from 'electron'
import { WINDOW_IPC } from '@shared/window'

export function registerWindowIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(WINDOW_IPC.minimize, () => {
    getWindow()?.minimize()
  })

  ipcMain.handle(WINDOW_IPC.maximizeToggle, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle(WINDOW_IPC.close, () => {
    getWindow()?.close()
  })

  ipcMain.handle(WINDOW_IPC.isMaximized, () => getWindow()?.isMaximized() ?? false)
}
