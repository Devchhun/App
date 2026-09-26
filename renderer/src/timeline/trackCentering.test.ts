import { describe, it, expect } from 'vitest'
import type { TimelineTrack } from '@shared/timelineTracks'
import { computeTrackCentering, computeSafeZoneHeight } from './trackCentering'

function track(overrides: Partial<TimelineTrack> & { id: string; kind: TimelineTrack['kind'] }): TimelineTrack {
  return { name: overrides.id, order: 0, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

describe('computeTrackCentering', () => {
  it('centers a lone main track at ~46% of the usable height', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { V1: 40 }, 400, 46, 54)
    const mainCenter = topSpacerHeight + 20
    expect(mainCenter / 400).toBeCloseTo(0.46, 1)
    expect(topSpacerHeight + 40 + bottomSpacerHeight).toBeCloseTo(400, 5)
  })

  it('keeps the main track anchored even when a track below it (e.g. linked audio) would otherwise pull the group center down', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 }), track({ id: 'A1', kind: 'audio', height: 40 })]
    const heights = { V1: 40, A1: 40 }
    const { topSpacerHeight } = computeTrackCentering(tracks, heights, 400, 46, 54)
    const mainCenter = topSpacerHeight + 20
    // Same main-track center as the lone-track case above -- the extra
    // below-track should shrink the BOTTOM spacer, not shift main up.
    expect(mainCenter / 400).toBeCloseTo(0.46, 1)
  })

  it('shrinks the top spacer as overlay tracks are added above main, never pushing main position negative', () => {
    const tracks = [track({ id: 'V2', kind: 'graphic', height: 40 }), track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const { topSpacerHeight } = computeTrackCentering(tracks, { V2: 40, V1: 40 }, 400, 46, 54)
    expect(topSpacerHeight).toBeGreaterThanOrEqual(0)
    // Overlay height (40) eats directly into what would otherwise be top spacer.
    const loneMainTop = computeTrackCentering([tracks[1]], { V1: 40 }, 400, 46, 54).topSpacerHeight
    expect(topSpacerHeight).toBeCloseTo(loneMainTop - 40, 5)
  })

  it('clamps both spacers to 0 once the tracks alone far exceed the usable height', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 }), track({ id: 'A1', kind: 'audio', height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { V1: 40, A1: 40 }, 20, 46, 54)
    expect(topSpacerHeight).toBe(0)
    expect(bottomSpacerHeight).toBe(0)
  })

  it('falls back to an even ratio split if no track is main (should not happen in practice)', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { A1: 40 }, 400, 46, 54)
    expect(topSpacerHeight + bottomSpacerHeight).toBeCloseTo(360, 5)
    expect(topSpacerHeight / bottomSpacerHeight).toBeCloseTo(46 / 54, 2)
  })

  // Large-monitor regression coverage: a very tall usable height (e.g. a
  // maximized 1920x1080+ window) must still land the main track at the same
  // ~46% target as a small one, with NO fixed-pixel ceiling silently
  // shifting it toward the top. An earlier version capped the top spacer at
  // a constant 90px past which all the extra height spilled into the bottom
  // spacer instead -- that made large panels visibly NOT centered, which is
  // exactly the bug this test guards against regressing to.
  it('stays proportional (not capped) on a very tall usable height, matching a small one', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const small = computeTrackCentering(tracks, { V1: 40 }, 400, 46, 54)
    const large = computeTrackCentering(tracks, { V1: 40 }, 2000, 46, 54)
    expect((small.topSpacerHeight + 20) / 400).toBeCloseTo((large.topSpacerHeight + 20) / 2000, 5)
    expect(large.topSpacerHeight).toBeGreaterThan(90)
    expect(large.topSpacerHeight + 40 + large.bottomSpacerHeight).toBeCloseTo(2000, 5)
  })

  it('stays proportional (not capped) in the no-main-track fallback too', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { A1: 40 }, 2000, 46, 54)
    expect(topSpacerHeight).toBeGreaterThan(90)
    expect(topSpacerHeight + 40 + bottomSpacerHeight).toBeCloseTo(2000, 5)
  })

  it('keeps requested breathing room below the last track when rows fill the panel', () => {
    const tracks = [track({ id: 'V2', kind: 'graphic', height: 40 }), track({ id: 'V1', kind: 'video', isMain: true, height: 40 }), track({ id: 'A1', kind: 'audio', height: 40 })]
    const result = computeTrackCentering(tracks, { V2: 40, V1: 40, A1: 40 }, 100, 40, 60, 16)
    expect(result.bottomSpacerHeight).toBe(16)
  })

  it('supports the Timeline\'s larger trailing breathing room without pushing the Main Track lower', () => {
    const tracks = [track({ id: 'V2', kind: 'graphic', height: 40 }), track({ id: 'V1', kind: 'video', isMain: true, height: 40 }), track({ id: 'C1', kind: 'caption', height: 34 })]
    const result = computeTrackCentering(tracks, { V2: 40, V1: 40, C1: 34 }, 120, 36, 64, 28)
    expect(result.topSpacerHeight).toBe(0)
    expect(result.bottomSpacerHeight).toBe(28)
  })
})

describe('computeSafeZoneHeight', () => {
  const RULER = 26
  const MAX = 34

  it('keeps the full band when the panel has room to spare', () => {
    // 300px panel, 60px of rows -- plenty left over.
    expect(computeSafeZoneHeight(300, RULER, 60, MAX)).toBe(MAX)
  })

  it('keeps the full band while the leftover is exactly enough', () => {
    // ruler + rows + band == viewport, to the pixel.
    expect(computeSafeZoneHeight(RULER + 60 + MAX, RULER, 60, MAX)).toBe(MAX)
  })

  it('gives up part of the band once the rows need the room', () => {
    // Only 20px left after the ruler and rows -- keep those 20, not 34.
    expect(computeSafeZoneHeight(RULER + 60 + 20, RULER, 60, MAX)).toBe(20)
  })

  it('collapses to zero rather than pushing rows off a squeezed panel', () => {
    // Panel shorter than the ruler and rows together: the band is the first
    // thing to go, so the rows keep as much of the panel as there is.
    expect(computeSafeZoneHeight(50, RULER, 60, MAX)).toBe(0)
  })

  it('never returns a negative height', () => {
    expect(computeSafeZoneHeight(10, RULER, 200, MAX)).toBe(0)
  })

  it('treats an unmeasured viewport as "not yet known", not "no room"', () => {
    // 0 is what the caller holds before its layout effect first measures --
    // collapsing here would flash the band closed and back open on mount.
    expect(computeSafeZoneHeight(0, RULER, 60, MAX)).toBe(MAX)
    expect(computeSafeZoneHeight(-5, RULER, 60, MAX)).toBe(MAX)
  })

  it('shrinks as more tracks are added to a fixed-height panel', () => {
    const panel = RULER + MAX + 60
    expect(computeSafeZoneHeight(panel, RULER, 60, MAX)).toBe(MAX)
    expect(computeSafeZoneHeight(panel, RULER, 80, MAX)).toBe(14)
    expect(computeSafeZoneHeight(panel, RULER, 94, MAX)).toBe(0)
  })
})
