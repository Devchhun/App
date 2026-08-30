import { describe, it, expect } from 'vitest'
import type { TimelineTrack } from '@shared/timelineTracks'
import { computeTrackCentering } from './trackCentering'

function track(overrides: Partial<TimelineTrack> & { id: string; kind: TimelineTrack['kind'] }): TimelineTrack {
  return { name: overrides.id, order: 0, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

// Effectively "no cap" for tests exercising the underlying ratio math on its
// own -- the cap itself gets its own dedicated tests below.
const NO_CAP = 100000

describe('computeTrackCentering', () => {
  it('centers a lone main track at ~46% of the usable height', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { V1: 40 }, 400, 46, 54, NO_CAP)
    const mainCenter = topSpacerHeight + 20
    expect(mainCenter / 400).toBeCloseTo(0.46, 1)
    expect(topSpacerHeight + 40 + bottomSpacerHeight).toBeCloseTo(400, 5)
  })

  it('keeps the main track anchored even when a track below it (e.g. linked audio) would otherwise pull the group center down', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 }), track({ id: 'A1', kind: 'audio', height: 40 })]
    const heights = { V1: 40, A1: 40 }
    const { topSpacerHeight } = computeTrackCentering(tracks, heights, 400, 46, 54, NO_CAP)
    const mainCenter = topSpacerHeight + 20
    // Same main-track center as the lone-track case above -- the extra
    // below-track should shrink the BOTTOM spacer, not shift main up.
    expect(mainCenter / 400).toBeCloseTo(0.46, 1)
  })

  it('shrinks the top spacer as overlay tracks are added above main, never pushing main position negative', () => {
    const tracks = [track({ id: 'V2', kind: 'graphic', height: 40 }), track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const { topSpacerHeight } = computeTrackCentering(tracks, { V2: 40, V1: 40 }, 400, 46, 54, NO_CAP)
    expect(topSpacerHeight).toBeGreaterThanOrEqual(0)
    // Overlay height (40) eats directly into what would otherwise be top spacer.
    const loneMainTop = computeTrackCentering([tracks[1]], { V1: 40 }, 400, 46, 54, NO_CAP).topSpacerHeight
    expect(topSpacerHeight).toBeCloseTo(loneMainTop - 40, 5)
  })

  it('clamps both spacers to 0 once the tracks alone far exceed the usable height', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 }), track({ id: 'A1', kind: 'audio', height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { V1: 40, A1: 40 }, 20, 46, 54, NO_CAP)
    expect(topSpacerHeight).toBe(0)
    expect(bottomSpacerHeight).toBe(0)
  })

  it('falls back to an even ratio split if no track is main (should not happen in practice)', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { A1: 40 }, 400, 46, 54, NO_CAP)
    expect(topSpacerHeight + bottomSpacerHeight).toBeCloseTo(360, 5)
    expect(topSpacerHeight / bottomSpacerHeight).toBeCloseTo(46 / 54, 2)
  })

  it('caps the top spacer on a tall panel instead of stretching the ruler-to-first-row gap indefinitely', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    // Uncapped, 46% of a 2000px-tall usable area would put the top spacer
    // at ~900px -- a cavernous gap leaving the playhead badge stranded.
    const { topSpacerHeight } = computeTrackCentering(tracks, { V1: 40 }, 2000, 46, 54, 90)
    expect(topSpacerHeight).toBe(90)
  })

  it('sends the space the cap held back to the bottom spacer, not off the total', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { V1: 40 }, 2000, 46, 54, 90)
    expect(topSpacerHeight + 40 + bottomSpacerHeight).toBeCloseTo(2000, 5)
  })

  it('never applies the cap when the natural top spacer is already smaller than it', () => {
    const tracks = [track({ id: 'V1', kind: 'video', isMain: true, height: 40 })]
    const uncapped = computeTrackCentering(tracks, { V1: 40 }, 200, 46, 54, NO_CAP).topSpacerHeight
    const capped = computeTrackCentering(tracks, { V1: 40 }, 200, 46, 54, 90).topSpacerHeight
    expect(uncapped).toBeLessThan(90)
    expect(capped).toBeCloseTo(uncapped, 5)
  })

  it('caps the top spacer in the no-main-track fallback too', () => {
    const tracks = [track({ id: 'A1', kind: 'audio', height: 40 })]
    const { topSpacerHeight, bottomSpacerHeight } = computeTrackCentering(tracks, { A1: 40 }, 2000, 46, 54, 90)
    expect(topSpacerHeight).toBe(90)
    expect(topSpacerHeight + 40 + bottomSpacerHeight).toBeCloseTo(2000, 5)
  })
})
