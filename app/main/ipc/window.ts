import { ipcMain, type BrowserWindow } from 'electron'
import { WINDOW_IPC } from '@shared/window'

/** The launcher-sized Home window (also the size the window is created
 * at, since Home is what a launch shows first -- see main/index.ts). */
export const HOME_WINDOW_WIDTH = 1052
export const HOME_WINDOW_HEIGHT = 673

/** The editor's own window size, kept while Home is showing so the
 * editor reopens exactly as it was left. Starts at the app's original
 * windowed size. */
const EDITOR_DEFAULT_BOUNDS = { x: 0, y: 0, width: 1440, height: 900 }
let editorState: { maximized: boolean; bounds: { x: number; y: number; width: number; height: number } } = { maximized: false, bounds: EDITOR_DEFAULT_BOUNDS }
let currentMode: 'home' | 'editor' | null = null

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

  ipcMain.handle(WINDOW_IPC.setMode, (_event, mode: 'home' | 'editor') => {
    const win = getWindow()
    if (!win) return
    if (mode === currentMode) return
    if (mode === 'editor') {
      currentMode = 'editor'
      // The editor comes back at whatever size it was last used at --
      // maximised if it was maximised, otherwise its own windowed size
      // (the app's original 1440x900 the first time), never Home's.
      if (editorState.maximized) {
        win.setBounds(editorState.bounds)
        win.maximize()
      } else {
        win.unmaximize()
        win.setBounds(editorState.bounds)
        win.center()
      }
      return
    }
    // Leaving the editor: remember how it was, then shrink to the launcher.
    if (currentMode === 'editor') editorState = { maximized: win.isMaximized(), bounds: win.isMaximized() ? editorState.bounds : win.getBounds() }
    currentMode = 'home'
    if (win.isMaximized()) win.unmaximize()
    win.setSize(HOME_WINDOW_WIDTH, HOME_WINDOW_HEIGHT, true)
    win.center()
  })
}
