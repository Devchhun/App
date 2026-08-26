import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { resolvePythonRuntime } from './pythonRuntime'
import { ensureVenv, type ProvisionProgress } from './provisionVenv'

export class WorkerCanceledError extends Error {
  constructor(message = 'Canceled') {
    super(message)
    this.name = 'WorkerCanceledError'
  }
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  onProgress?: (data: unknown) => void
}

interface WorkerMessage {
  id: string
  type: 'ready' | 'progress' | 'result' | 'error'
  data?: unknown
  message?: string
  canceled?: boolean
}

/**
 * Manages the single long-lived local Python AI worker subprocess. The main
 * process owns the entire lifecycle: it resolves which interpreter to use
 * (bundled portable runtime in production, an app-managed venv in dev),
 * starts it on demand, and is responsible for terminating it when the app
 * quits. The renderer never talks to this process directly.
 */
export class PythonWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, PendingRequest>()
  private startPromise: Promise<void> | null = null
  private stdoutBuffer = ''
  private provisionListeners: Array<(p: ProvisionProgress) => void> = []

  onProvisionProgress(cb: (p: ProvisionProgress) => void): void {
    this.provisionListeners.push(cb)
  }

  private emitProvisionProgress(p: ProvisionProgress): void {
    for (const cb of this.provisionListeners) cb(p)
  }

  async ensureStarted(): Promise<void> {
    if (this.proc) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async start(): Promise<void> {
    const runtime = resolvePythonRuntime()
    let pythonExe = runtime.pythonExecutable
    if (runtime.mode === 'venv') {
      pythonExe = await ensureVenv((p) => this.emitProvisionProgress(p))
    }

    const proc = spawn(pythonExe, ['-u', runtime.workerScript], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    proc.stderr.on('data', () => {
      // Library logs (tqdm bars, ctranslate2/onnxruntime warnings) land here.
      // Intentionally not surfaced; protocol data only ever arrives on stdout.
    })
    proc.on('exit', () => {
      this.proc = null
      const err = new Error('Worker process exited unexpectedly')
      for (const pending of this.pending.values()) pending.reject(err)
      this.pending.clear()
    })

    await this.waitForReady(proc)
  }

  private waitForReady(proc: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker did not become ready in time')), 60_000)
      this.pending.set('worker', {
        resolve: () => {
          clearTimeout(timeout)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timeout)
          reject(err)
        }
      })
      proc.once('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf-8')
    let newlineIndex: number
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (!line) continue
      let msg: WorkerMessage
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: WorkerMessage): void {
    const pending = this.pending.get(msg.id)
    if (!pending) return

    if (msg.type === 'ready' || msg.type === 'result') {
      pending.resolve(msg.data)
      this.pending.delete(msg.id)
    } else if (msg.type === 'progress') {
      pending.onProgress?.(msg.data)
    } else if (msg.type === 'error') {
      pending.reject(msg.canceled ? new WorkerCanceledError(msg.message) : new Error(msg.message ?? 'Worker error'))
      this.pending.delete(msg.id)
    }
  }

  send(cmd: string, args: Record<string, unknown>, onProgress?: (data: unknown) => void): { id: string; promise: Promise<unknown> } {
    if (!this.proc) throw new Error('Worker not started')
    const id = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
    })
    this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n')
    return { id, promise }
  }

  sendControl(action: 'pause' | 'resume' | 'cancel'): void {
    if (!this.proc) return
    this.proc.stdin.write(JSON.stringify({ id: randomUUID(), cmd: 'control', args: { action } }) + '\n')
  }

  /** Called on app quit. Terminates the worker; safe to call even if it never started. */
  stop(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

let sharedWorker: PythonWorker | null = null

export function getSharedWorker(): PythonWorker {
  if (!sharedWorker) sharedWorker = new PythonWorker()
  return sharedWorker
}
