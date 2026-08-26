import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type RightTab = 'ai' | 'localAi' | 'story' | 'graphics' | 'brand'
export type LeftView = 'media' | 'transcript' | 'templates'

interface UiStateContextValue {
  rightTab: RightTab
  setRightTab: (tab: RightTab) => void
  leftView: LeftView
  setLeftView: (view: LeftView) => void
}

const UiStateContext = createContext<UiStateContextValue | null>(null)

export function UiStateProvider({ children }: { children: ReactNode }): JSX.Element {
  const [rightTab, setRightTabState] = useState<RightTab>('ai')
  const [leftView, setLeftViewState] = useState<LeftView>('media')

  const setRightTab = useCallback((tab: RightTab) => setRightTabState(tab), [])
  const setLeftView = useCallback((view: LeftView) => setLeftViewState(view), [])

  const value = useMemo<UiStateContextValue>(
    () => ({ rightTab, setRightTab, leftView, setLeftView }),
    [rightTab, setRightTab, leftView, setLeftView]
  )

  return <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>
}

export function useUiState(): UiStateContextValue {
  const ctx = useContext(UiStateContext)
  if (!ctx) throw new Error('useUiState must be used within UiStateProvider')
  return ctx
}
