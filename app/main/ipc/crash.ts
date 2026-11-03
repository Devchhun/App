import { app, ipcMain } from 'electron'
import { join } from 'path'
import { appendFile, mkdir } from 'fs/promises'
import { CRASH_IPC, type CrashReport } from '@shared/crash'

function crashLogPath(): string {
  return join(app.getPath('userData'), 'crash-log.txt')
}

/** A best-effort persistent record of renderer crashes the ErrorBoundary
 * catches -- without this, a crash is only visible while its error screen is
 * still on screen and DevTools happens to be open, which for most users is
 * never. Appending to a plain file survives the app being closed/reopened,
 * so a crash that isn't screenshotted in time is still diagnosable later. */
export function registerCrashIpc(): void {
  ipcMain.handle(CRASH_IPC.report, async (_event, report: CrashReport) => appendCrashLog({ ...report }))
}

/** One line in the same file, for trouble the main process sees itself (a
 * window that came up empty -- see windowWatch.ts). */
export async function appendCrashLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await appendFile(crashLogPath(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    // Logging the crash must never itself throw.
  }
}
