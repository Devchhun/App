// Auto-update via electron-updater against GitHub Releases (electron-builder.yml's
// `publish` config). Packaged builds only -- there is no meaningful "update"
// concept in dev (no installer, no GitHub release to check against), and
// electron-updater's own dev-mode behavior (reading dev-app-update.yml) isn't
// set up here on purpose. Every step degrades to a harmless no-op/log on
// failure (offline, no releases published yet, etc.) rather than blocking
// the app from starting.
import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

let wired = false

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged || wired) return
  wired = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message)
  })

  autoUpdater.on('update-downloaded', (info) => {
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

  // One check shortly after launch -- not on a repeating timer, since this is
  // a manually-launched desktop app (not a long-running background service);
  // the next check naturally happens the next time the app starts.
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] checkForUpdates failed:', err.message)
  })
}
