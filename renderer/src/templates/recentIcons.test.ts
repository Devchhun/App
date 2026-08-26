import { describe, it, expect, beforeEach } from 'vitest'
import { loadRecentIcons, pushRecentIcon } from './recentIcons'

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage()
})

describe('recentIcons', () => {
  it('starts empty', () => {
    expect(loadRecentIcons()).toEqual([])
  })

  it('records a pushed icon as most recent', () => {
    pushRecentIcon('warning')
    expect(loadRecentIcons()).toEqual(['warning'])
  })

  it('moves a re-pushed icon to the front instead of duplicating it', () => {
    pushRecentIcon('warning')
    pushRecentIcon('money')
    pushRecentIcon('warning')
    expect(loadRecentIcons()).toEqual(['warning', 'money'])
  })

  it('caps the list at 8 entries, dropping the oldest', () => {
    const ids = ['warning', 'security', 'bank', 'money', 'device', 'location', 'person', 'statistics', 'check'] as const
    for (const id of ids) pushRecentIcon(id)
    const result = loadRecentIcons()
    expect(result).toHaveLength(8)
    expect(result[0]).toBe('check') // most recently pushed
    expect(result).not.toContain('warning') // oldest, evicted
  })

  it('filters out unknown/stale ids from storage instead of throwing', () => {
    localStorage.setItem('creative-ai-editor.recentIcons', JSON.stringify(['warning', 'not-a-real-icon']))
    expect(loadRecentIcons()).toEqual(['warning'])
  })

  it('tolerates corrupt JSON in storage', () => {
    localStorage.setItem('creative-ai-editor.recentIcons', '{not json')
    expect(loadRecentIcons()).toEqual([])
  })
})
