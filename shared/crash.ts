export const CRASH_IPC = {
  report: 'crash:report'
} as const

export interface CrashReport {
  message: string
  stack?: string
  componentStack?: string
}
