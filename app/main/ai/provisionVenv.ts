import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getVenvDir, getVenvPythonPath } from './pythonRuntime'

export interface ProvisionProgress {
  stage: 'checking-python' | 'creating-venv' | 'installing-dependencies' | 'ready' | 'error'
  message?: string
  percent: number
}

const REQUIREMENTS_PATH = join(__dirname, '../../python-worker/requirements.txt')

function findSystemPython(): Promise<string | null> {
  return new Promise((resolve) => {
    const candidates: Array<{ bin: string; versionArgs: string[] }> = [
      { bin: 'py', versionArgs: ['-3', '--version'] },
      { bin: 'python', versionArgs: ['--version'] }
    ]
    let index = 0
    const tryNext = (): void => {
      if (index >= candidates.length) {
        resolve(null)
        return
      }
      const candidate = candidates[index++]
      const proc = spawn(candidate.bin, candidate.versionArgs)
      proc.on('error', tryNext)
      proc.on('close', (code) => {
        if (code === 0) resolve(candidate.bin)
        else tryNext()
      })
    }
    tryNext()
  })
}

function runToCompletion(bin: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args)
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => onLine?.(chunk.toString().trim()))
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
      onLine?.(text.trim())
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split('\n').slice(-8).join('\n') || `${bin} exited with code ${code}`))
    })
  })
}

/** Creates and provisions the app-managed venv on first use. No-op if it already exists. */
export async function ensureVenv(onProgress: (p: ProvisionProgress) => void): Promise<string> {
  const venvPython = getVenvPythonPath()
  if (existsSync(venvPython)) {
    onProgress({ stage: 'ready', percent: 100 })
    return venvPython
  }

  onProgress({ stage: 'checking-python', percent: 0 })
  const systemPython = await findSystemPython()
  if (!systemPython) {
    const err = new Error(
      'No local Python 3.9+ installation found. Install Python from https://www.python.org/downloads/ (check "Add Python to PATH") and restart the app.'
    )
    onProgress({ stage: 'error', percent: 0, message: err.message })
    throw err
  }

  onProgress({ stage: 'creating-venv', percent: 10 })
  const venvDir = getVenvDir()
  const createArgs = systemPython === 'py' ? ['-3', '-m', 'venv', venvDir] : ['-m', 'venv', venvDir]
  await runToCompletion(systemPython, createArgs)

  onProgress({ stage: 'installing-dependencies', percent: 25 })
  await runToCompletion(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  await runToCompletion(venvPython, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH], (line) => {
    onProgress({ stage: 'installing-dependencies', percent: 40, message: line })
  })

  onProgress({ stage: 'ready', percent: 100 })
  return venvPython
}
