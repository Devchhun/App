import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { sanitizeStoryLibrary } = await import('./storyLibraryStore')

describe('sanitizeStoryLibrary', () => {
  const jpeg = 'data:image/jpeg;base64,/9j/AAAA'

  it('returns an empty library for anything malformed', () => {
    expect(sanitizeStoryLibrary(null)).toEqual({ stories: [] })
    expect(sanitizeStoryLibrary({ stories: 'x' })).toEqual({ stories: [] })
  })

  it('keeps stories and characters, dropping ones without ids and non-image data', () => {
    const library = sanitizeStoryLibrary({
      stories: [
        { id: 's1', title: ' Gu An ', updatedAt: '2026-09-26T00:00:00.000Z', characters: [
          { id: 'c1', name: 'គូ អាន', image: jpeg },
          { id: 'c2', name: 'x', image: 'data:text/html;base64,PHA+' },
          { name: 'no id', image: jpeg }
        ] },
        { title: 'no id' }
      ]
    })
    expect(library).toEqual({ stories: [{ id: 's1', title: 'Gu An', updatedAt: '2026-09-26T00:00:00.000Z', characters: [
      { id: 'c1', name: 'គូ អាន', image: jpeg },
      { id: 'c2', name: 'x', image: '' }
    ] }] })
  })

  it('drops oversized photos', () => {
    const huge = `data:image/jpeg;base64,${'A'.repeat(500_000)}`
    expect(sanitizeStoryLibrary({ stories: [{ id: 's', characters: [{ id: 'c', name: 'n', image: huge }] }] }).stories[0].characters[0].image).toBe('')
  })
})
