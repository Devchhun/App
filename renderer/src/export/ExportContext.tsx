import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProjectSequence } from '@shared/project'
import type { ExportOptions, ExportProgress, ExportCapabilities } from '@shared/export'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/export'

export type ExportPhase = 'form' | 'exporting' | 'success' | 'error' | 'canceled'

interface ExportContextValue {
  isOpen: boolean
  openDialog: () => void
  closeDialog: () => void

  capabilities: ExportCapabilities | null
  options: ExportOptions
  setOptions: (patch: Partial<ExportOptions>) => void
  pickOutputDir: () => Promise<void>

  phase: ExportPhase
  progress: ExportProgress | null
  startExport: (sequence: ProjectSequence, mediaById: Record<string, { originalPath: string }>, aspectRatio: '16:9' | '9:16' | '1:1') => void
  cancelExport: () => void
  resetToForm: () => void
}

const ExportContext = createContext<ExportContextValue | null>(null)

export function ExportProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<ExportCapabilities | null>(null)
  const [options, setOptionsState] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [phase, setPhase] = useState<ExportPhase>('form')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const currentRequestId = useRef<string | null>(null)

  const setOptions = useCallback((patch: Partial<ExportOptions>) => {
    setOptionsState((prev) => ({ ...prev, ...patch }))
  }, [])

  const openDialog = useCallback(() => {
    setIsOpen(true)
    setPhase('form')
    setProgress(null)
    void window.api.export.getCapabilities().then((caps) => {
      setCapabilities(caps)
      setOptionsState((prev) => {
        let next = prev
        if (caps.availableCodecs.length > 0 && !caps.availableCodecs.includes(prev.codec)) next = { ...next, codec: caps.availableCodecs[0] }
        if (!prev.outputDir && caps.defaultOutputDir) next = { ...next, outputDir: caps.defaultOutputDir }
        return next
      })
    })
  }, [])

  const closeDialog = useCallback(() => {
    setIsOpen(false)
  }, [])

  const resetToForm = useCallback(() => {
    setPhase('form')
    setProgress(null)
    currentRequestId.current = null
  }, [])

  const pickOutputDir = useCallback(async () => {
    const result = await window.api.export.pickOutputDir()
    if (!result.canceled && result.path) setOptionsState((prev) => ({ ...prev, outputDir: result.path! }))
  }, [])

  useEffect(() => {
    return window.api.export.onProgress((p) => {
      if (currentRequestId.current !== p.requestId) return
      setProgress(p)
      if (p.status === 'success') setPhase('success')
      else if (p.status === 'error') setPhase('error')
      else if (p.status === 'canceled') setPhase('canceled')
    })
  }, [])

  const startExport = useCallback(
    (sequence: ProjectSequence, mediaById: Record<string, { originalPath: string }>, aspectRatio: '16:9' | '9:16' | '1:1') => {
      const requestId = crypto.randomUUID()
      currentRequestId.current = requestId
      setPhase('exporting')
      setProgress({ requestId, percent: 0, status: 'exporting' })
      void window.api.export.startExport(requestId, sequence, mediaById, aspectRatio, options)
    },
    [options]
  )

  const cancelExport = useCallback(() => {
    if (currentRequestId.current) void window.api.export.cancelExport(currentRequestId.current)
  }, [])

  const value = useMemo<ExportContextValue>(
    () => ({
      isOpen,
      openDialog,
      closeDialog,
      capabilities,
      options,
      setOptions,
      pickOutputDir,
      phase,
      progress,
      startExport,
      cancelExport,
      resetToForm
    }),
    [isOpen, openDialog, closeDialog, capabilities, options, setOptions, pickOutputDir, phase, progress, startExport, cancelExport, resetToForm]
  )

  return <ExportContext.Provider value={value}>{children}</ExportContext.Provider>
}

export function useExport(): ExportContextValue {
  const ctx = useContext(ExportContext)
  if (!ctx) throw new Error('useExport must be used within ExportProvider')
  return ctx
}
