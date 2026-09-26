import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

export interface PythonRuntimeInfo {
  pythonExecutable: string
  mode: 'bundled' | 'venv'
  venvDir?: string
  workerScript: string
}

/**
 * In a packaged build, `scripts/fetch-portable-python.ps1` stages a portable
 * CPython + pre-installed worker dependencies under resources/python-runtime
 * (packaged via electron-builder `extraResources`). If present, that's used
 * directly and no system Python / venv provisioning is needed at all.
 */
function bundledPythonPath(): string | null {
  // electron-vite bundles all main-process source into a single out/main/index.js,
  // so __dirname at runtime is always out/main regardless of source file location.
  const base = app.isPackaged
    ? join(process.resourcesPath, 'python-runtime')
    : join(__dirname, '../../resources/python-runtime')
  const exe = join(base, 'python.exe')
  return existsSync(exe) ? exe : null
}

/** The app's OWN bundled Python, or null when this build doesn't ship one.
 * Exposed separately from resolvePythonRuntime because Edge TTS only needs
 * the interpreter (it has no worker script and no venv fallback -- if the
 * bundled runtime isn't there, the caller falls back to a user-provided
 * install instead of provisioning anything). */
export function getBundledPythonPath(): string | null {
  return bundledPythonPath()
}

export function getVenvDir(): string {
  return join(app.getPath('userData'), 'python-env')
}

export function getVenvPythonPath(): string {
  return join(getVenvDir(), 'Scripts', 'python.exe')
}

export function getWorkerScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'python-worker', 'worker.py')
    : join(__dirname, '../../python-worker/worker.py')
}

export function resolvePythonRuntime(): PythonRuntimeInfo {
  const bundled = bundledPythonPath()
  if (bundled) {
    return { pythonExecutable: bundled, mode: 'bundled', workerScript: getWorkerScriptPath() }
  }
  return {
    pythonExecutable: getVenvPythonPath(),
    mode: 'venv',
    venvDir: getVenvDir(),
    workerScript: getWorkerScriptPath()
  }
}
