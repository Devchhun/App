import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { SettingsCategoryId } from './settingsSections'
import { wasHomeSeen } from '../home/homeSession'

/** The right sidebar is now only the two project-content panels. AI
 * Suggestions, Local AI Planner and Story Visuals moved into the Settings
 * dialog (see settingsSections.ts's `tool` categories and `openSettings`
 * below), so the sidebar no longer competes with them for width. */
export type RightTab = 'graphics' | 'brand' | 'videoStory' | 'aiAnimation'
/** Settings is deliberately NOT one of these: it configures the whole app
 * (theme, updates, the dubbing engine), not the left column's working
 * content, so it opens as its own dialog rather than replacing the Media
 * panel -- see `settingsOpen` below. */
export type LeftView = 'media' | 'transcript' | 'templates' | 'aiScript'

interface UiStateContextValue {
  rightTab: RightTab
  setRightTab: (tab: RightTab) => void
  leftView: LeftView
  setLeftView: (view: LeftView) => void
  requestVideoStory: () => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  /** Which category the Settings dialog shows. Lives here rather than in
   * the dialog so entry points elsewhere (the rail's AI button, the
   * titlebar's Generate button, "View all suggestions") can open straight
   * onto a specific one. */
  settingsCategory: SettingsCategoryId
  setSettingsCategory: (category: SettingsCategoryId) => void
  openSettings: (category?: SettingsCategoryId) => void
  /** True while a voiceover take is being counted in or recorded. Everything
   * except the Preview and the Timeline dims out while it is, so a stray
   * click on an unrelated panel can't disturb the take -- and so it's
   * obvious at a glance that the app is listening. */
  recordingFocus: boolean
  setRecordingFocus: (active: boolean) => void
  /** The Home screen (project list) covers the editor: on at launch,
   * off once a project is chosen, back on from the titlebar's Home. */
  homeOpen: boolean
  openHome: () => void
  closeHome: () => void
}

const UiStateContext = createContext<UiStateContextValue | null>(null)

export function UiStateProvider({ children }: { children: ReactNode }): JSX.Element {
  const [rightTab, setRightTabState] = useState<RightTab>('graphics')
  const [leftView, setLeftViewState] = useState<LeftView>('media')
  const [settingsOpen, setSettingsOpenState] = useState(false)
  const [settingsCategory, setSettingsCategoryState] = useState<SettingsCategoryId>('appearance')
  const [recordingFocus, setRecordingFocusState] = useState(false)
  const [homeOpen, setHomeOpen] = useState(() => !wasHomeSeen())
  const openHome = useCallback(() => setHomeOpen(true), [])
  const closeHome = useCallback(() => setHomeOpen(false), [])

  const setRightTab = useCallback((tab: RightTab) => setRightTabState(tab), [])
  const setLeftView = useCallback((view: LeftView) => setLeftViewState(view), [])
  const requestVideoStory = useCallback(() => {
    setRightTabState('videoStory')
  }, [])
  const setSettingsOpen = useCallback((open: boolean) => setSettingsOpenState(open), [])
  const setSettingsCategory = useCallback((category: SettingsCategoryId) => setSettingsCategoryState(category), [])
  const openSettings = useCallback((category?: SettingsCategoryId) => {
    if (category) setSettingsCategoryState(category)
    setSettingsOpenState(true)
  }, [])
  const setRecordingFocus = useCallback((active: boolean) => setRecordingFocusState(active), [])

  const value = useMemo<UiStateContextValue>(
    () => ({
      rightTab,
      setRightTab,
      leftView,
      setLeftView,
      requestVideoStory,
      settingsOpen,
      setSettingsOpen,
      settingsCategory,
      setSettingsCategory,
      openSettings,
      recordingFocus,
      setRecordingFocus,
      homeOpen,
      openHome,
      closeHome
    }),
    [rightTab, setRightTab, leftView, setLeftView, requestVideoStory, settingsOpen, setSettingsOpen, settingsCategory, setSettingsCategory, openSettings, recordingFocus, setRecordingFocus, homeOpen, openHome, closeHome]
  )

  return <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>
}

export function useUiState(): UiStateContextValue {
  const ctx = useContext(UiStateContext)
  if (!ctx) throw new Error('useUiState must be used within UiStateProvider')
  return ctx
}
