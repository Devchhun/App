import { describe, expect, it } from 'vitest'
import { MANGA_SUBTITLE_REASON, mangaScriptFromPassages, mangaScriptFromScenes } from './mangaScript'

describe('mangaScriptFromPassages', () => {
  it('makes a paragraph of each passage', () => {
    expect(mangaScriptFromPassages([['មួយ។', 'ពីរ។'], [], ['បី។']])).toBe('មួយ។ ពីរ។\n\nបី។')
  })
})

describe('mangaScriptFromScenes', () => {
  it('reads the AI Manga subtitles in order, a paragraph per picture, nothing else', () => {
    const scene = (startTime: number, visualText: string, reason = MANGA_SUBTITLE_REASON) => ({ startTime, visualText, reason })
    const scenes = [scene(4, 'បី។'), scene(0, 'មួយ។'), scene(2, 'ពីរ។'), scene(1, 'title', 'other')]
    expect(mangaScriptFromScenes(scenes, [0, 4])).toBe('មួយ។ ពីរ។\n\nបី។')
  })
})
