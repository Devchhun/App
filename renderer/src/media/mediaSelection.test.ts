import { describe, expect, it } from 'vitest'
import { updateMediaSelection, clearMediaSelection, selectAllMedia } from './mediaSelection'

describe('updateMediaSelection', () => {
  it('plain click replaces the selection with just the clicked item', () => {
    expect(updateMediaSelection(['a', 'b'], 'c', ['a', 'b', 'c'])).toEqual(['c'])
  })

  it('plain click on an already-sole-selected item is a no-op (same reference)', () => {
    const current = ['a']
    expect(updateMediaSelection(current, 'a', ['a', 'b'])).toBe(current)
  })

  it('ctrl+click toggles an item into the selection', () => {
    expect(updateMediaSelection(['a'], 'b', ['a', 'b', 'c'], { ctrl: true })).toEqual(['a', 'b'])
  })

  it('ctrl+click toggles an item out of the selection', () => {
    expect(updateMediaSelection(['a', 'b'], 'b', ['a', 'b', 'c'], { ctrl: true })).toEqual(['a'])
  })

  it('shift+click selects the contiguous range from the last-selected anchor', () => {
    expect(updateMediaSelection(['a'], 'd', ['a', 'b', 'c', 'd'], { shift: true })).toEqual(['a', 'b', 'c', 'd'])
  })

  it('shift+click with no prior selection behaves like a plain click', () => {
    expect(updateMediaSelection([], 'b', ['a', 'b', 'c'], { shift: true })).toEqual(['b'])
  })
})

describe('clearMediaSelection', () => {
  it('clears a non-empty selection', () => {
    expect(clearMediaSelection(['a', 'b'])).toEqual([])
  })
  it('is a no-op (same reference) when already empty', () => {
    const current: string[] = []
    expect(clearMediaSelection(current)).toBe(current)
  })
})

describe('selectAllMedia', () => {
  it('returns every id', () => {
    expect(selectAllMedia(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
