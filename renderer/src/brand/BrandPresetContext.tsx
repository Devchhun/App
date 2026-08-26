import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { BrandPreset } from '@shared/project'
import { createDefaultBrandPreset } from '@shared/project'

interface BrandPresetContextValue {
  brandPreset: BrandPreset
  updateBrandPreset: (patch: Partial<BrandPreset>) => void
  setBrandPreset: (preset: BrandPreset) => void
}

const BrandPresetContext = createContext<BrandPresetContextValue | null>(null)

export function BrandPresetProvider({ children }: { children: ReactNode }): JSX.Element {
  const [brandPreset, setBrandPresetState] = useState<BrandPreset>(createDefaultBrandPreset())

  const updateBrandPreset = useCallback((patch: Partial<BrandPreset>) => {
    setBrandPresetState((prev) => ({ ...prev, ...patch }))
  }, [])

  const setBrandPreset = useCallback((preset: BrandPreset) => setBrandPresetState(preset), [])

  const value = useMemo<BrandPresetContextValue>(
    () => ({ brandPreset, updateBrandPreset, setBrandPreset }),
    [brandPreset, updateBrandPreset, setBrandPreset]
  )

  return <BrandPresetContext.Provider value={value}>{children}</BrandPresetContext.Provider>
}

export function useBrandPreset(): BrandPresetContextValue {
  const ctx = useContext(BrandPresetContext)
  if (!ctx) throw new Error('useBrandPreset must be used within BrandPresetProvider')
  return ctx
}
