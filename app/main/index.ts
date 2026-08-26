import { app, shell, BrowserWindow, ipcMain, Menu, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerPrivilegedScheme, registerMediaProtocolHandler } from './media/protocol'
import { registerMediaIpc } from './ipc/media'
import { registerTranscriptionIpc } from './ipc/transcription'
import { registerProjectIpc } from './ipc/project'
import { registerAiIpc } from './ipc/ai'
import { registerLocalAiIpc } from './ipc/localAi'
import { registerStoryIpc } from './ipc/story'
import { registerExportIpc } from './ipc/export'
import { registerWindowIpc } from './ipc/window'
import { getSharedWorker } from './ai/workerProcess'
import { initAutoUpdater } from './updater'
import { TRANSCRIPTION_IPC } from '@shared/transcription'
import { WINDOW_IPC } from '@shared/window'

// Must run before app 'ready'.
registerPrivilegedScheme()

let mainWindow: BrowserWindow | null = null

/** Same dev-vs-packaged resolution convention as pythonRuntime.ts's
 * bundledPythonPath -- __dirname at runtime is always out/main regardless of
 * source file location, and the icon is copied into the packaged app's
 * top-level resources folder via electron-builder's extraResources. Windows
 * falls back to the packaged .exe's own embedded icon (electron-builder.yml's
 * win.icon) when this file is missing, so an absent icon.ico never breaks
 * window creation -- it just leaves the generic Electron icon in dev. */
function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(__dirname, '../../build/icon.ico')
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#090b14',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Chromium recognizes Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z as reserved "edit command"
  // accelerators at the native input layer, ahead of the DOM's own keydown
  // dispatch -- even with no Electron Menu installed (see Menu.setApplicationMenu(null)
  // above), Chromium's own default handling for these can still race with
  // and swallow the effect of the renderer's own Ctrl+Z/Ctrl+Shift+Z undo/redo
  // (HistoryContext.tsx), which owns the app's actual undo stack. Intercepting
  // here, before Chromium applies its native default action, is the standard
  // fix -- the keydown still reaches the renderer's own listeners normally.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control) return
    const key = input.key.toLowerCase()
    if (key === 'z' || key === 'y') {
      event.preventDefault()
    }
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send(WINDOW_IPC.maximizedChanged, true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send(WINDOW_IPC.maximizedChanged, false))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  getSharedWorker().onProvisionProgress((p) => {
    mainWindow?.webContents.send(TRANSCRIPTION_IPC.workerStatus, p)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This app has an entirely custom frameless titlebar/chrome and its own
// Ctrl+Z/Ctrl+Shift+Z/Ctrl+D/Delete/etc handlers in the renderer -- without
// this, Electron's DEFAULT application menu (invisible with autoHideMenuBar,
// but still installed and still intercepting accelerators) silently
// swallows those exact same keystrokes as native Edit-menu actions (Undo,
// Redo, Cut, Copy, Paste, Select All) before they ever reach the renderer's
// own keydown listeners.
Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  registerMediaProtocolHandler()

  // Record Voiceover (checkpoint 4) needs getUserMedia mic access -- grant
  // only the 'media' (audio/video capture) permission and deny everything
  // else (geolocation, notifications, etc.) by default, least-privilege for
  // an app with no web content beyond its own renderer.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())
  registerMediaIpc(() => mainWindow)
  registerTranscriptionIpc()
  registerProjectIpc()
  registerAiIpc()
  registerLocalAiIpc()
  registerStoryIpc()
  registerExportIpc()
  registerWindowIpc(() => mainWindow)

  createMainWindow()
  initAutoUpdater(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// The Python worker must never outlive the app -- stop it explicitly rather
// than relying on OS process-tree cleanup.
app.on('will-quit', () => {
  getSharedWorker().stop()
})
