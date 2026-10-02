import { describe, expect, it } from 'vitest'
import { planSeparationChunks } from './vocalRemoval'

/** Length of the joined result: every kept stretch, minus one crossfade per seam. */
function joinedLength(chunks: ReturnType<typeof planSeparationChunks>, crossfade = 0.05): number {
  return chunks.reduce((sum, c) => sum + (c.keepTo - c.keepFrom), 0) - (chunks.length - 1) * crossfade
}

describe('planSeparationChunks', () => {
  it('keeps a short file in one piece', () => {
    expect(planSeparationChunks(120)).toEqual([{ start: 0, length: 120, keepFrom: 0, keepTo: 120 }])
  })

  it('cuts a feature-length file into five-minute pieces that rejoin to its exact length', () => {
    const chunks = planSeparationChunks(5525.1)
    expect(chunks).toHaveLength(19)
    expect(joinedLength(chunks)).toBeCloseTo(5525.1, 6)
    // Every piece is decoded with context on both inner sides...
    expect(chunks[1].start).toBe(298)
    expect(chunks[1].length).toBe(304)
    // ...and keeps only its own stretch (plus half a crossfade per seam).
    expect(chunks[1].keepFrom).toBeCloseTo(1.975, 6)
    expect(chunks[1].keepTo).toBeCloseTo(302.025, 6)
    // The last piece runs to the end of the file.
    const last = chunks[chunks.length - 1]
    expect(last.start + last.length).toBeCloseTo(5525.1, 6)
    expect(last.start + last.keepTo).toBeCloseTo(5525.1, 6)
    // Nothing is decoded past the file's ends.
    for (const c of chunks) {
      expect(c.start).toBeGreaterThanOrEqual(0)
      expect(c.keepFrom).toBeGreaterThanOrEqual(0)
      expect(c.keepTo).toBeLessThanOrEqual(c.length + 1e-9)
    }
  })

  it('lets a short tail join the piece before it', () => {
    const chunks = planSeparationChunks(610)
    expect(chunks).toHaveLength(2)
    expect(chunks[1].start + chunks[1].length).toBe(610)
    expect(joinedLength(chunks)).toBeCloseTo(610, 6)
  })

  it('has nothing to do for an empty file', () => {
    expect(planSeparationChunks(0)).toEqual([])
  })
})
