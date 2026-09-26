import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { applyTheme, persistTheme, readStoredTheme, type AppTheme } from './themePrefs'

/** One owner for the light/dark choice, so every control that shows or
 * changes it agrees. Both the Titlebar's quick toggle and the Settings
 * switch read and write THIS, rather than each holding its own useState
 * seeded from storage -- two independent copies of one preference means
 * changing it in one place leaves the other showing (and acting on) a stale
 * value, which reads as "the button doesn't work". */
interface ThemeContextValue {
  theme: AppTheme
  setTheme: (theme: AppTheme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<AppTheme>(() => readStoredTheme())

  const setTheme = useCallback((next: AppTheme) => {
    setThemeState(next)
    applyTheme(next)
    persistTheme(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: AppTheme = prev === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      persistTheme(next)
      return next
    })
  }, [])

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
