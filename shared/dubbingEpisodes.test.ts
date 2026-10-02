import { describe, expect, it } from 'vitest'
import { createDefaultDubbingWorkspaceState, withoutTransientDubbingState, type DubbingEpisode } from './dubbing'
import { episodeSrtFileName, episodesToTranscribe, episodeWorkspaceOf, isSeriesWideFailure, withEpisodeOpen, withEpisodesAdded } from './dubbingEpisodes'

const ep = (mediaId: string, fileName: string, status: DubbingEpisode['status'] = 'waiting'): DubbingEpisode => ({ mediaId, fileName, status })

describe('series episodes', () => {
  it('keeps episodes in the order a person numbers them', () => {
    const list = withEpisodesAdded([], [
      { mediaId: 'c', fileName: 'Drama EP10.mp4' },
      { mediaId: 'a', fileName: 'Drama EP2.mp4' },
      { mediaId: 'b', fileName: 'drama ep1.mp4' }
    ])
    expect(list.map((e) => e.mediaId)).toEqual(['b', 'a', 'c'])
  })

  it('adds only videos it does not have yet', () => {
    const list = [ep('a', 'EP1.mp4', 'done')]
    expect(withEpisodesAdded(list, [{ mediaId: 'a', fileName: 'EP1.mp4' }])).toBe(list)
    const next = withEpisodesAdded(list, [{ mediaId: 'a', fileName: 'EP1.mp4' }, { mediaId: 'b', fileName: 'EP2.mp4' }, { mediaId: 'b', fileName: 'EP2.mp4' }])
    expect(next.map((e) => [e.mediaId, e.status])).toEqual([['a', 'done'], ['b', 'waiting']])
  })

  it('opens an episode with its own subtitles setup and keeps series settings', () => {
    const live = { ...createDefaultDubbingWorkspaceState(), active: true, videoMediaId: 'a', srtFileName: 'a.srt', customVoiceReferenceAudioPath: 'ref.wav', generationError: 'old', segments: { s1: { segmentId: 's1', detectedGender: 'male' as const, pitch: 0, speed: 1, volumeDb: 0, status: 'generated' as const } } }
    const parked = episodeWorkspaceOf(live)
    const opened = withEpisodeOpen(live, 'b', undefined)
    expect(opened.videoMediaId).toBe('b')
    expect(opened.segments).toEqual({})
    expect(opened.srtFileName).toBeUndefined()
    expect(opened.generationError).toBeUndefined()
    expect(opened.customVoiceReferenceAudioPath).toBe('ref.wav')
    const back = withEpisodeOpen(opened, 'a', parked)
    expect(back.segments).toEqual(live.segments)
    expect(back.srtFileName).toBe('a.srt')
  })

  it('names each saved SRT after its video', () => {
    expect(episodeSrtFileName('My Drama EP03.mp4')).toBe('My Drama EP03.srt')
    expect(episodeSrtFileName('noext')).toBe('noext.srt')
  })

  it('transcribes what is waiting or failed, and stops on a repeated reason', () => {
    expect(episodesToTranscribe([ep('a', '1', 'done'), ep('b', '2', 'failed'), ep('c', '3')])).toEqual(['b', 'c'])
    expect(isSeriesWideFailure(undefined, 'no key')).toBe(false)
    expect(isSeriesWideFailure('no key', 'no key')).toBe(true)
    expect(isSeriesWideFailure('timeout', 'no key')).toBe(false)
  })

  it('saves an interrupted Auto SRT as waiting, and cleans parked lines too', () => {
    const state = {
      ...createDefaultDubbingWorkspaceState(),
      episodes: [
        { ...ep('a', '1', 'transcribing') },
        { ...ep('b', '2', 'done'), workspace: { genderDetectionStatus: 'idle' as const, speakers: {}, segments: { s: { segmentId: 's', detectedGender: 'unknown' as const, pitch: 0, speed: 1, volumeDb: 0, status: 'generating' as const, voiceId: 'v' } } } }
      ]
    }
    const saved = withoutTransientDubbingState(state)
    expect(saved.episodes?.[0].status).toBe('waiting')
    expect(saved.episodes?.[1].workspace?.segments.s.status).toBe('voice-assigned')
  })
})
