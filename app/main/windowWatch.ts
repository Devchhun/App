import type { BrowserWindow } from 'electron'

/** After the page has loaded, how long the app has to put something on
 * screen. It draws at once (the licence check alone shows a line of text),
 * so an empty page this long after loading is a page that did not start. */
const MOUNT_GRACE_MS = 4000
/** How long a page may take to load at all -- a development server still
 * warming up after a restart, a request that never comes back. */
const LOAD_LIMIT_MS = 45000
/** Reloads allowed inside RETRY_WINDOW_MS: a page that keeps coming up
 * empty, or keeps crashing, is left alone after that. */
const MAX_RETRIES = 3
const RETRY_WINDOW_MS = 2 * 60 * 1000
const KEPT_ERRORS = 12

/** A window that opens and shows nothing -- the page failed to load, its
 * scripts stopped before the app started, its process died -- is loaded
 * again by itself, and what went wrong is written down (`log`). Without
 * this the window stays a blank dark rectangle until the app is restarted
 * by hand, with nothing to say why. */
export function reloadWhenBlank(win: BrowserWindow, log: (entry: Record<string, unknown>) => void): void {
  const wc = win.webContents
  let timer: ReturnType<typeof setTimeout> | null = null
  let errors: string[] = []
  let retriedAt: number[] = []

  const wait = (ms: number, then: () => void): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      then()
    }, ms)
  }

  const retry = (why: string): void => {
    if (win.isDestroyed() || wc.isDestroyed()) return
    const now = Date.now()
    retriedAt = retriedAt.filter((at) => now - at < RETRY_WINDOW_MS)
    const again = retriedAt.length < MAX_RETRIES
    log({ source: 'window', message: `The window showed nothing: ${why}.${again ? ' Loading it again.' : ' Not loading it again -- that was tried.'}`, errors })
    if (!again) return
    retriedAt.push(now)
    errors = []
    wc.reloadIgnoringCache()
  }

  const check = (why: string): void => {
    if (win.isDestroyed() || wc.isDestroyed()) return
    wc.executeJavaScript(`(document.getElementById('root') || {}).childElementCount || 0`, true)
      .then((drawn: number) => {
        if (!drawn) retry(why)
      })
      .catch(() => retry(why))
  }

  // A load that failed still "finishes" (on Chromium's own error page).
  let failed = false
  wc.on('did-start-loading', () => {
    errors = []
    failed = false
    wait(LOAD_LIMIT_MS, () => check('the page did not finish loading'))
  })
  wc.on('did-finish-load', () => {
    if (failed) return
    wait(MOUNT_GRACE_MS, () => check('the page loaded but the app did not start'))
  })
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3: the load was replaced by another one (a reload), not a failure.
    if (!isMainFrame || errorCode === -3) return
    failed = true
    errors.push(`${errorDescription} (${errorCode}) ${validatedURL}`)
    wait(1500, () => retry(`the page could not be loaded (${errorDescription})`))
  })
  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 3) return
    errors.push(`${message} (${sourceId}:${line})`.slice(0, 400))
    if (errors.length > KEPT_ERRORS) errors.shift()
  })
  wc.on('preload-error', (_event, preloadPath, error) => {
    errors.push(`preload ${preloadPath}: ${error.message}`.slice(0, 400))
  })
  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    wait(1000, () => retry(`the page's process ended (${details.reason})`))
  })
  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    timer = null
  })
}
