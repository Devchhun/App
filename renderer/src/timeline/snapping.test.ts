import { describe, expect, it } from 'vitest'
import type { TimelineClip, Marker } from '@shared/project'
import { buildSnapCandidates, findSnapMatch } from './snapping'

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, locked: false, ...overrides }
}

describe('buildSnapCandidates', () => {
  it('always includes timeline start and the playhead', () => {
    const candidates = buildSnapCandidates({ clips: [], markers: [], scenes: [], captionSegments: [], playheadTime: 12 })
    expect(candidates).toContainEqual({ time: 0, kind: 'timeline-start' })
    expect(candidates).toContainEqual({ time: 12, kind: 'playhead' })
  })

  it('includes every clip start/end except excluded ones', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 3 }), clip({ id: 'b', trackId: 'V1', startTime: 20, duration: 2 })]
    const candidates = buildSnapCandidates({ clips, markers: [], scenes: [], captionSegments: [], playheadTime: 0, excludeClipIds: new Set(['b']) })
    expect(candidates.some((c) => c.time === 5 && c.kind === 'clip-start')).toBe(true)
    expect(candidates.some((c) => c.time === 8 && c.kind === 'clip-end')).toBe(true)
    expect(candidates.some((c) => c.time === 20)).toBe(false)
  })

  it('marks selected clips with selected-boundary instead of clip-start/end', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 5, duration: 3 })]
    const candidates = buildSnapCandidates({ clips, markers: [], scenes: [], captionSegments: [], playheadTime: 0, selectedClipIds: new Set(['a']) })
    expect(candidates.filter((c) => c.time === 5 || c.time === 8).every((c) => c.kind === 'selected-boundary')).toBe(true)
  })

  it('includes markers, scenes, captions, and the in/out range', () => {
    const marker: Marker = { id: 'm1', time: 3, color: '#fff', name: 'Note' }
    const candidates = buildSnapCandidates({
      clips: [],
      markers: [marker],
      scenes: [{ startTime: 1, endTime: 2 }],
      captionSegments: [{ startTime: 10, endTime: 11 }],
      playheadTime: 0,
      inOutRange: { start: 20, end: 21 }
    })
    expect(candidates).toContainEqual({ time: 3, kind: 'marker', label: 'Note' })
    expect(candidates.some((c) => c.time === 1 && c.kind === 'scene-boundary')).toBe(true)
    expect(candidates.some((c) => c.time === 10 && c.kind === 'caption-boundary')).toBe(true)
    expect(candidates.some((c) => c.time === 20 && c.kind === 'in-point')).toBe(true)
    expect(candidates.some((c) => c.time === 21 && c.kind === 'out-point')).toBe(true)
  })
})

describe('findSnapMatch', () => {
  const candidates = [
    { time: 5, kind: 'clip-start' as const },
    { time: 5.2, kind: 'playhead' as const },
    { time: 20, kind: 'timeline-start' as const }
  ]

  it('snaps to the closest candidate within the pixel threshold', () => {
    // At 20px/s, an 8px threshold = 0.4s.
    const result = findSnapMatch(5.05, candidates, 8, 20)
    expect(result.snapped).toBe(true)
    expect(result.time).toBe(5)
  })

  it('picks the closer of two candidates both within range', () => {
    const result = findSnapMatch(5.15, candidates, 8, 20)
    expect(result.candidate?.time).toBe(5.2)
  })

  it('does not snap when nothing is within the threshold', () => {
    const result = findSnapMatch(10, candidates, 8, 20)
    expect(result.snapped).toBe(false)
    expect(result.time).toBe(10)
  })

  it('the same pixel threshold is a stricter (smaller) time tolerance at a higher zoom level', () => {
    // 8px at 100px/s = 0.08s tolerance -- 0.5s away is out of range.
    // 8px at 5px/s = 1.6s tolerance -- 0.5s away is well within range.
    const zoomedIn = findSnapMatch(5.5, candidates, 8, 100)
    const zoomedOut = findSnapMatch(5.5, candidates, 8, 5)
    expect(zoomedIn.snapped).toBe(false)
    expect(zoomedOut.snapped).toBe(true)
  })
})
