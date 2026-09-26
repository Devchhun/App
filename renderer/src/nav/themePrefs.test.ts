import { describe, it, expect } from 'vitest'
import { parseStoredTheme, DEFAULT_APP_THEME } from './themePrefs'

describe('parseStoredTheme', () => {
  it('accepts both real themes', () => {
    expect(parseStoredTheme('dark')).toBe('dark')
    expect(parseStoredTheme('light')).toBe('light')
  })

  it('falls back to the default for missing or unknown values', () => {
    expect(parseStoredTheme(null)).toBe(DEFAULT_APP_THEME)
    expect(parseStoredTheme('')).toBe(DEFAULT_APP_THEME)
    expect(parseStoredTheme('solarized')).toBe(DEFAULT_APP_THEME)
  })

  it('defaults to dark -- a video editor grades against a dark surround', () => {
    expect(DEFAULT_APP_THEME).toBe('dark')
  })
})
