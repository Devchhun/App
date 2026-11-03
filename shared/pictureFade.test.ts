import { describe, expect, it } from 'vitest'
import { hasPictureFade, pictureFadeAt, pictureFadeFfmpegSteps } from './pictureFade'

describe('pictureFadeAt', () => {
  const clip = { duration: 4, pictureFadeIn: 0.5, pictureFadeOut: 0.5 }

  it('comes in from nothing, stays whole, goes out to nothing', () => {
    expect(pictureFadeAt(clip, 0)).toBe(0)
    expect(pictureFadeAt(clip, 0.25)).toBeCloseTo(0.5)
    expect(pictureFadeAt(clip, 2)).toBe(1)
    expect(pictureFadeAt(clip, 3.75)).toBeCloseTo(0.5)
    expect(pictureFadeAt(clip, 4)).toBe(0)
  })

  it('keeps each fade within half a short clip, and is whole with none', () => {
    expect(pictureFadeAt({ duration: 0.6, pictureFadeIn: 1 }, 0.15)).toBeCloseTo(0.5)
    expect(pictureFadeAt({ duration: 3 }, 0)).toBe(1)
    expect(hasPictureFade({ duration: 3 })).toBe(false)
    expect(hasPictureFade(clip)).toBe(true)
  })
})

describe('pictureFadeFfmpegSteps', () => {
  it('fades the bottom track to black and a picture over others to see-through', () => {
    expect(pictureFadeFfmpegSteps({ duration: 4, pictureFadeIn: 0.3, pictureFadeOut: 0.3 }, false)).toEqual(['fade=t=in:st=0:d=0.3', 'fade=t=out:st=3.7:d=0.3'])
    expect(pictureFadeFfmpegSteps({ duration: 4, pictureFadeOut: 0.3 }, true)).toEqual(['format=yuva420p', 'fade=t=out:st=3.7:d=0.3:alpha=1'])
    expect(pictureFadeFfmpegSteps({ duration: 4 }, true)).toEqual([])
  })
})
