import { constants, setPriority } from 'os'
import type { ChildProcess } from 'child_process'

/** Heavy background work -- encodes, voice separation, the TTS models --
 * runs below normal priority, so on a small machine the app's own window
 * still gets the CPU first and never freezes behind a job. On a machine
 * with cores to spare nothing is slower: priority only matters when there
 * is a queue. */
export function runInBackground<T extends ChildProcess>(proc: T): T {
  if (proc.pid) {
    try {
      setPriority(proc.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Already gone, or not allowed -- it simply runs at normal priority.
    }
  }
  return proc
}
