import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.', isPackaged: false }, safeStorage: {} }))

import { batchPrompt, dropTextOnly, linesByGroup, thinShare } from './mangaRecapService'

describe('linesByGroup', () => {
  it('matches passages to the groups asked for, by number, and keeps a skipped group silent', () => {
    const out = linesByGroup({ groups: [{ index: 12, lines: [' b ', ''], focus: [{ x: 0.2, y: 0.8 }] }, { index: 10, lines: ['a'], focus: [] }] }, 10, [3, 3, 1])
    expect(out.map((g) => g.lines)).toEqual([['a'], [], ['b']])
    expect(out[2].focus).toEqual([{ x: 0.2, y: 0.8 }])
    expect(out[1].focus).toHaveLength(3)
  })
})

describe('batchPrompt', () => {
  it('asks for one connected recap, a passage per group of three, opening and closing the episode', () => {
    const prompt = batchPrompt('km', '', '', 0, 13, 13, 3)
    expect(prompt).toContain('ONE story')
    expect(prompt).toContain('3 at a time')
    expect(prompt).toContain('opens the video')
    expect(prompt).toContain('ends the episode')
    expect(prompt).toContain('Khmer script')
  })
  it('keeps every passage on its own pictures: what is seen first, nothing told early, no wrong names', () => {
    const prompt = batchPrompt('km', '', '', 0, 38, 38, 1)
    expect(prompt).toContain('ITS OWN pictures')
    expect(prompt).toContain('"seen" first')
    expect(prompt).toContain('Never tell an event before its picture comes')
    expect(prompt).toContain('Name a character only when')
    expect(prompt).toContain('A picture with no one in it')
    expect(prompt).toContain('publisher')
  })

  it('carries a long video from chapter to chapter without new openings or goodbyes', () => {
    const middle = batchPrompt('km', '', 'Ye Tian got the copy system.', 0, 30, 30, 1, { continues: true, more: true })
    expect(middle).toContain('follows straight on in the same video from the chapter before')
    expect(middle).toContain('end this one mid-story')
    expect(middle).toContain('cover of the comic again')
    expect(middle).not.toContain('opens the video')
    expect(middle).not.toContain('wants the next episode')
  })
})

describe('dropTextOnly', () => {
  const w = (index: number, lines: string[], textOnly: boolean[]) => ({ index, lines, focus: textOnly.map(() => ({ x: 0.5, y: 0.5 })), motion: textOnly.map(() => 'none' as const), textOnly })

  it('leaves out pictures that are only words, keeping their words with the picture before', () => {
    const out = dropTextOnly([['a'], ['b'], ['c']], [w(0, ['one'], [false]), w(1, ['words'], [true]), w(2, ['three'], [false])])
    expect(out.paths).toEqual([['a'], ['c']])
    expect(out.written.map((g) => g.lines)).toEqual([['one', 'words'], ['three']])
    expect(out.leftOut).toBe(1)
  })

  it('carries words at the very start to the first picture, and thins a group of three', () => {
    const out = dropTextOnly([['t'], ['a', 'b', 'c']], [w(0, ['title'], [true]), w(1, ['story'], [false, true, false])])
    expect(out.paths).toEqual([['a', 'c']])
    expect(out.written[0].lines).toEqual(['title', 'story'])
    expect(out.written[0].focus).toHaveLength(2)
    expect(out.leftOut).toBe(2)
  })
})

describe('thinShare', () => {
  it('counts shown pictures told in one short line, not pictures left out for being words', () => {
    const g = (lines: string[], textOnly = false) => ({ index: 0, lines, focus: [{ x: 0.5, y: 0.5 }], textOnly: [textOnly] })
    const full = 'ក'.repeat(90)
    expect(thinShare([g([full]), g(['ខ្លី']), g([], true), g([full])])).toBeCloseTo(1 / 3)
  })
})
