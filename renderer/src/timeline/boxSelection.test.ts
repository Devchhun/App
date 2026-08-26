import { describe, expect, it } from 'vitest'
import { normalizeRect, clipsInRect, applyBoxSelection, type ClipGeometry } from './boxSelection'

describe('normalizeRect', () => {
  it('normalizes a rect dragged in any direction to left<=right, top<=bottom', () => {
    expect(normalizeRect(50, 50, 10, 10)).toEqual({ left: 10, right: 50, top: 10, bottom: 50 })
    expect(normalizeRect(10, 10, 50, 50)).toEqual({ left: 10, right: 50, top: 10, bottom: 50 })
  })
})

const geometries: ClipGeometry[] = [
  { id: 'a', trackId: 'V1', left: 0, right: 50, top: 0, bottom: 40 },
  { id: 'b', trackId: 'V1', left: 60, right: 100, top: 0, bottom: 40 },
  { id: 'c', trackId: 'A1', left: 0, right: 50, top: 40, bottom: 80 }
]

describe('clipsInRect', () => {
  it('selects every clip intersecting the rect, across multiple tracks', () => {
    const rect = normalizeRect(0, 0, 55, 80)
    expect(clipsInRect(rect, geometries).sort()).toEqual(['a', 'c'])
  })

  it('excludes clips entirely outside the rect', () => {
    const rect = normalizeRect(0, 0, 20, 20)
    expect(clipsInRect(rect, geometries)).toEqual(['a'])
  })

  it('a rect that touches but does not overlap a clip does not select it', () => {
    const rect = normalizeRect(50, 0, 60, 40)
    expect(clipsInRect(rect, geometries)).toEqual([])
  })
})

describe('applyBoxSelection', () => {
  it('default drag replaces the selection', () => {
    expect(applyBoxSelection(['x'], ['a', 'b'])).toEqual(['a', 'b'])
  })
  it('ctrl+drag toggles intersected clips', () => {
    expect(applyBoxSelection(['a'], ['a', 'b'], { ctrl: true }).sort()).toEqual(['b'])
  })
  it('shift+drag adds intersected clips to the current selection', () => {
    expect(applyBoxSelection(['x'], ['a', 'b'], { shift: true }).sort()).toEqual(['a', 'b', 'x'])
  })
})
