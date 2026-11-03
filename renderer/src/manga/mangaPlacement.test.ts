import { describe, expect, it } from 'vitest'
import { createEmptySequence } from '@shared/project'
import { MANGA_DIP_SECONDS } from '@shared/mangaRecap'
import { placeMangaGroups, type PlacedGroup } from './mangaPlacement'
import { getMainVideoTrackId } from '../timeline/trackModel'

const picture = (id: string) => ({ imageMediaId: `img-${id}`, imageSize: { width: 800, height: 1200 }, focusX: 0.5, focusY: 0.9 })
const group = (ids: string[], audioSeconds: number, patch: Partial<PlacedGroup> = {}): PlacedGroup => ({
  pictures: ids.map(picture),
  audioMediaId: audioSeconds > 0 ? `voice-${ids[0]}` : null,
  audioSeconds,
  lines: audioSeconds > 0 ? [{ text: `line ${ids[0]}`, start: 0, end: audioSeconds }] : [],
  ...patch
})

describe('placeMangaGroups, one picture at a time', () => {
  it('puts each picture on the main track for as long as its voice, the voices under them, back to back', () => {
    let n = 0
    const out = placeMangaGroups(createEmptySequence(), [group(['a'], 3), group(['b'], 0), group(['c'], 2)], '16:9', () => `id${n++}`)
    const main = getMainVideoTrackId(out.sequence.tracks)
    const images = out.sequence.clips.filter((c) => c.type === 'image')
    const voices = out.sequence.clips.filter((c) => c.type === 'audio')
    expect(images.map((c) => c.trackId)).toEqual([main, main, main])
    expect(images.map((c) => c.startTime)).toEqual([0, 3, 5.5])
    expect(voices.map((c) => [c.mediaId, c.startTime])).toEqual([['voice-a', 0], ['voice-c', 5.5]])
    expect(voices[0].trackId).not.toBe(main)
    // Shown whole and still: no zoom, no keyframes.
    expect(images.every((c) => !c.keyframes && c.transform?.scaleX === 1 && c.transform?.y === 0)).toBe(true)
    expect(images[0].backgroundBlur).toBeGreaterThan(0)
    // Each picture dips to dark into the next, as the user's reference channel does.
    expect(images.every((c) => c.pictureFadeIn === MANGA_DIP_SECONDS && c.pictureFadeOut === MANGA_DIP_SECONDS)).toBe(true)
    expect(out.subtitles).toEqual([{ text: 'line a', start: 0, end: 3 }, { text: 'line c', start: 5.5, end: 7.5 }])
  })

  it('starts after what is already on the main track', () => {
    const first = placeMangaGroups(createEmptySequence(), [group(['a'], 3)], '16:9')
    const second = placeMangaGroups(first.sequence, [group(['b'], 1)], '16:9')
    expect(second.start).toBeCloseTo(first.end)
    expect(second.sequence.clips.filter((c) => c.type === 'image')).toHaveLength(2)
  })

  it('puts one narration clip under everything when the passages were joined', () => {
    const out = placeMangaGroups(createEmptySequence(), [group(['a'], 3), group(['b'], 0), group(['c'], 2)], '16:9', undefined, { mediaId: 'narration', seconds: 7.5 })
    expect(out.sequence.clips.filter((c) => c.type === 'audio')).toEqual([expect.objectContaining({ mediaId: 'narration', startTime: 0, duration: 7.5 })])
  })

  it('lengthens a group by its pause and keeps its last subtitle up through it', () => {
    const out = placeMangaGroups(createEmptySequence(), [group(['a'], 3, { pauseAfter: 0.3 }), group(['c'], 2)], '16:9')
    expect(out.subtitles).toEqual([{ text: 'line a', start: 0, end: 3.3 }, { text: 'line c', start: 3.3, end: 5.3 }])
  })
})

describe('placeMangaGroups, 3 side by side', () => {
  it('shows each group of three in full view for its whole passage, on its backdrop', () => {
    const groups = [group(['a', 'b', 'c'], 6), group(['d'], 4)]
    const out = placeMangaGroups(createEmptySequence(), groups, '16:9', undefined, { mediaId: 'narration', seconds: 10 }, ['bg1', 'bg2'])
    const main = getMainVideoTrackId(out.sequence.tracks)
    const images = out.sequence.clips.filter((c) => c.type === 'image')
    expect(images.filter((c) => c.trackId === main).map((c) => [c.mediaId, c.startTime, c.duration])).toEqual([['bg1', 0, 6], ['bg2', 6, 4]])
    // Every panel one clip, as long as its group, never dimmed.
    const panels = images.filter((c) => c.trackId !== main)
    expect(panels.map((c) => [c.mediaId, c.startTime, c.duration, c.opacity])).toEqual([
      ['img-a', 0, 6, undefined],
      ['img-b', 0, 6, undefined],
      ['img-c', 0, 6, undefined],
      ['img-d', 6, 4, undefined]
    ])
    expect(panels.map((c) => c.transform?.x)).toEqual([-640, 0, 640, -640])
    expect(new Set(panels.map((c) => c.trackId)).size).toBe(3)
    expect(out.subtitles).toEqual([{ text: 'line a', start: 0, end: 6 }, { text: 'line d', start: 6, end: 10 }])
  })
})

describe('placeMangaGroups, moving characters', () => {
  it('puts each cut-out over its still picture on a Characters track, a touch larger, with its motion', () => {
    const withCutout = (id: string, motion: 'breathe' | 'none') => ({ ...picture(id), cutoutMediaId: `cut-${id}`, motion })
    const groups: PlacedGroup[] = [{ ...group(['a'], 3), pictures: [withCutout('a', 'breathe')] }, { ...group(['b'], 2), pictures: [withCutout('b', 'none')] }]
    const out = placeMangaGroups(createEmptySequence(), groups, '16:9')
    const main = getMainVideoTrackId(out.sequence.tracks)
    const cut = out.sequence.clips.filter((c) => c.mediaId.startsWith('cut-'))
    // Only the scene that moves gets its cut-out; the picture behind stays still.
    expect(cut.map((c) => [c.mediaId, c.startTime, c.duration, c.motion?.preset])).toEqual([['cut-a', 0, 3, 'pulse']])
    expect(cut[0].trackId).not.toBe(main)
    expect(out.sequence.tracks.find((t) => t.id === cut[0].trackId)?.name).toBe('Characters')
    expect(cut[0].transform?.scaleX).toBeGreaterThan(1)
    expect(out.sequence.clips.filter((c) => c.trackId === main).every((c) => !c.motion && !c.keyframes)).toBe(true)
  })
})
