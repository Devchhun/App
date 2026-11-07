import { describe, expect, it } from 'vitest'
import { episodeNumber, pairByEpisode } from './pairMatch'

describe('episodeNumber', () => {
  it('reads EP / Episode labels, ignoring other numbers', () => {
    expect(episodeNumber('E:\\x\\✨Renegade Immortal EP 45 [MULTI SUB] [FLojzagpOrQ].mp4')).toBe(45)
    expect(episodeNumber('295 - Renegade Immortal - Full Story Explained (Episode 45).mp4')).toBe(45)
    expect(episodeNumber('294 - ... (Episode 46).mp4')).toBe(46)
  })
  it('reads Khmer digits after ភាគ', () => {
    expect(episodeNumber('គុជអមតះធានី ភាគទី ៤៥.mp4')).toBe(45)
  })
  it('returns null when there is no episode number', () => {
    expect(episodeNumber('my video.mp4')).toBeNull()
  })
})

describe('pairByEpisode', () => {
  it('matches by episode even when the folders sort in different orders', () => {
    const originals = ['EP 45.mp4', 'EP 46.mp4', 'EP 47.mp4']
    // Recaps numbered by upload order = REVERSE episode order.
    const editeds = ['281 - (Episode 47).mp4', '282 - (Episode 46).mp4', '283 - (Episode 45).mp4']
    const r = pairByEpisode(originals, editeds)
    expect(r.method).toBe('episode')
    expect(r.originals).toEqual(['EP 45.mp4', 'EP 46.mp4', 'EP 47.mp4'])
    expect(r.editeds).toEqual(['283 - (Episode 45).mp4', '282 - (Episode 46).mp4', '281 - (Episode 47).mp4'])
  })

  it('reports originals with no matching edit', () => {
    const r = pairByEpisode(['EP 45.mp4', 'EP 99.mp4'], ['(Episode 45).mp4'])
    expect(r.method).toBe('episode')
    expect(r.originals).toEqual(['EP 45.mp4'])
    expect(r.unmatched).toEqual(['EP 99.mp4'])
  })

  it('falls back to order when episode numbers are missing', () => {
    const r = pairByEpisode(['a.mp4', 'b.mp4'], ['x.mp4', 'y.mp4', 'z.mp4'])
    expect(r.method).toBe('order')
    expect(r.originals).toEqual(['a.mp4', 'b.mp4'])
    expect(r.editeds).toEqual(['x.mp4', 'y.mp4'])
  })
})
