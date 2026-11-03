import { describe, expect, it } from 'vitest'
import { voiceCutShort, withoutLatinAsides, asMangaMotion, isGoodCutout, joinPause, mangaClipMotion, panelPan, sortPanelPaths, timeLines, trioPlacement } from './mangaRecap'

describe('sortPanelPaths', () => {
  it('reads numbers in names as numbers', () => {
    expect(sortPanelPaths(['C:/m/p10.png', 'C:/m/p2.png', 'C:/m/p1.png'])).toEqual(['C:/m/p1.png', 'C:/m/p2.png', 'C:/m/p10.png'])
  })
})

describe('timeLines', () => {
  it('splits the voice by sentence length and ends exactly on it', () => {
    const lines = timeLines(['ខ្លី', 'ប្រយោគនេះវែងជាងមុនបន្តិច', ''], 6)
    expect(lines).toHaveLength(2)
    expect(lines[0].start).toBe(0)
    expect(lines[0].end).toBeLessThan(lines[1].end - lines[1].start)
    expect(lines[1].end).toBe(6)
  })

  it('gives nothing for no words or no voice', () => {
    expect(timeLines([' '], 3)).toEqual([])
    expect(timeLines(['a'], 0)).toEqual([])
  })
})

describe('panelPan', () => {
  it('pans a tall panel up and down only, within what overflows the frame', () => {
    const pan = panelPan({ width: 800, height: 1200 }, '16:9', 0.9, 0)
    // Fitted to 1080 tall, zoomed 1.08: 86.4 units overflow, 43.2 each way.
    expect(pan.endY).toBeCloseTo(43.2, 1)
    // 720 wide in a 1920 frame: no room to pan sideways.
    expect(pan.endX).toBe(0)
  })

  it('stays still for a picture of unknown size or a centred action', () => {
    expect(panelPan({}, '16:9', 0.1, 0.1)).toEqual({ endX: 0, endY: 0 })
    expect(panelPan({ width: 1920, height: 1080 }, '16:9', 0.5, 0.5)).toEqual({ endX: 0, endY: 0 })
  })
})

describe('joinPause', () => {
  it('adds nothing by default', () => {
    expect(joinPause(0)).toBe(0)
  })

  it('tops a join up to a given breath', () => {
    expect(joinPause(0, 0.3)).toBe(0.3)
    expect(joinPause(0.2, 0.3)).toBe(0.1)
    expect(joinPause(0.5, 0.3)).toBe(0)
  })
})

describe('trioPlacement', () => {
  it('puts a tall panel in its third of the frame, fitted to the column box', () => {
    // 1000 x 1800: whole-frame fit is by height (0.6); the column box fits it by height too (1000/1800).
    const left = trioPlacement({ width: 1000, height: 1800 }, 0)
    expect(left.x).toBe(-640)
    expect(left.scale).toBeCloseTo((1000 / 1800) / 0.6, 3)
    expect(trioPlacement({ width: 1000, height: 1800 }, 2).x).toBe(640)
  })

  it('fits a wide panel by the column width', () => {
    // 1000 x 400: whole-frame fit 1.92 (by width), column box 0.6 (by width).
    expect(trioPlacement({ width: 1000, height: 400 }, 1)).toEqual({ x: 0, scale: 0.3125 })
  })
})

describe('mangaClipMotion', () => {
  it('gives each kind a small, slow motion and none to a still scene', () => {
    expect(mangaClipMotion('breathe')).toEqual({ preset: 'pulse', speed: 0.5, amount: 0.1 })
    expect(mangaClipMotion('none')).toBeNull()
    expect(asMangaMotion('shake')).toBe('shake')
    expect(asMangaMotion('dance')).toBe('none')
  })
})

describe('voiceCutShort', () => {
  it('tells a voice cut to a fraction of its passage from a whole read', () => {
    const text = 'ក'.repeat(152)
    expect(voiceCutShort(text, 0.64)).toBe(true)
    expect(voiceCutShort(text, 8)).toBe(false)
    expect(voiceCutShort('ទេ!', 0.3)).toBe(false)
  })
})

describe('withoutLatinAsides', () => {
  it('drops a name repeated in Latin letters, and keeps other brackets', () => {
    expect(withoutLatinAsides('ឈ្មោះថា យេ ធាន (Ye Tian) ដែលជាតួអង្គ')).toBe('ឈ្មោះថា យេ ធាន ដែលជាតួអង្គ')
    expect(withoutLatinAsides('គេ (ក្នុងចិត្ត) ស្រែក')).toBe('គេ (ក្នុងចិត្ត) ស្រែក')
  })
})

describe('isGoodCutout', () => {
  // [alpha, count] runs of a grey character (or [alpha, count, grey]).
  const pixels = (runs: Array<[number, number, number?]>) => runs.flatMap(([a, n, grey = 120]) => Array.from({ length: n }, () => [grey, grey, grey, a]).flat())
  it('keeps a solid character with soft edges, even in a white shirt', () => {
    expect(isGoodCutout(pixels([[255, 30], [120, 5], [0, 65]]))).toBe(true)
    expect(isGoodCutout(pixels([[255, 12, 250], [255, 18], [0, 70]]))).toBe(true)
  })

  it('drops next to nothing, the whole picture, see-through haze and a lone speech bubble', () => {
    expect(isGoodCutout(pixels([[255, 5], [0, 95]]))).toBe(false)
    expect(isGoodCutout(pixels([[255, 95], [0, 5]]))).toBe(false)
    expect(isGoodCutout(pixels([[255, 6], [150, 30], [0, 64]]))).toBe(false)
    expect(isGoodCutout(pixels([[255, 16, 250], [255, 4], [0, 80]]))).toBe(false)
    expect(isGoodCutout([])).toBe(false)
  })
})
