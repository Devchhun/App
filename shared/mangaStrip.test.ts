import { describe, expect, it } from 'vitest'
import { chapterImageUrls, DEFAULT_STRIP_CUT, findScenes, mangatoonComicId, mangatoonEpisodesUrl, parseMangatoonEpisodes, rowStds } from './mangaStrip'

/** A strip `width` wide: picture rows vary, gutter rows are flat. */
function strip(width: number, layout: Array<['pic' | 'gap', number]>): Float32Array {
  const rows: number[] = []
  for (const [kind, n] of layout) for (let i = 0; i < n; i++) rows.push(kind === 'pic' ? 40 : 0)
  return Float32Array.from(rows)
}

describe('rowStds', () => {
  it('is 0 for a flat row and large for a striped one', () => {
    const gray = Uint8Array.from([10, 10, 10, 10, 0, 255, 0, 255])
    const out = rowStds(gray, 4)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeGreaterThan(100)
  })
})

describe('findScenes', () => {
  it('cuts at gutters and drops the gutters', () => {
    expect(findScenes(strip(100, [['gap', 10], ['pic', 120], ['gap', 8], ['pic', 90]]), 100)).toEqual([[10, 130], [138, 228]])
  })

  it('does not cut at a thin flat line inside a picture', () => {
    expect(findScenes(strip(100, [['pic', 60], ['gap', 2], ['pic', 60]]), 100)).toEqual([[0, 122]])
  })

  it('joins a short caption piece to the picture after it', () => {
    expect(findScenes(strip(100, [['pic', 20], ['gap', 6], ['pic', 100]]), 100)).toEqual([[0, 126]])
  })

  it('splits a scene much taller than wide', () => {
    const scenes = findScenes(strip(100, [['pic', 500]]), 100)
    expect(scenes.length).toBeGreaterThan(1)
    expect(scenes.every(([a, b]) => b - a <= 220)).toBe(true)
    expect(scenes[0][0]).toBe(0)
    expect(scenes[scenes.length - 1][1]).toBe(500)
  })

  it('keeps a tall picture whole when splitting is off', () => {
    expect(findScenes(strip(100, [['pic', 500]]), 100, { ...DEFAULT_STRIP_CUT, maxSceneRatio: 0 })).toEqual([[0, 500]])
  })
})

describe('MangaToon chapter lists', () => {
  it('finds the comic in any of its links', () => {
    expect(mangatoonComicId('https://mangatoon.mobi/en/watch/2858198/151259')).toBe('2858198')
    expect(mangatoonComicId('https://mangatoon.mobi/en/detail/2858198/episodes')).toBe('2858198')
    expect(mangatoonComicId('https://mangatoon.mobi/en/your-talent-is-mine?content_id=2858198')).toBe('2858198')
    expect(mangatoonComicId('https://example.com/watch/1/2')).toBeNull()
    expect(mangatoonEpisodesUrl('2858198', 'https://mangatoon.mobi/en/watch/2858198/151259')).toBe('https://mangatoon.mobi/en/detail/2858198/episodes')
  })

  it('reads each chapter once, in number order', () => {
    const item = (ep: number, n: number) => `<a class="episode-item-new" data-id="${ep}" href="/en/watch/7/${ep}"> <div class="item-top"> <div class="episode-title-new episode-number">${n}</div> <div class="episode-title-new"> Episode ${n} </div> </div></a>`
    const html = item(20, 2) + item(10, 1) + item(20, 2) + '<a href="/en/watch/8/99">other comic</a>'
    expect(parseMangatoonEpisodes(html, '7', 'https://mangatoon.mobi')).toEqual([
      { number: 1, title: 'Episode 1', url: 'https://mangatoon.mobi/en/watch/7/10' },
      { number: 2, title: 'Episode 2', url: 'https://mangatoon.mobi/en/watch/7/20' }
    ])
  })
})

describe('chapterImageUrls', () => {
  it('keeps MangaToon chapter pictures in page order, not the poster', () => {
    const html = '<img src="https://x.mangatoon.mobi/cartoon-posters/1.jpg"><img data-src="https://en.mangatoon.mobi/ps/9/watermark/1000/Z.jpg"><img src="https://en.mangatoon.mobi/ps/9/watermark/1000/A.jpg"><img src="https://en.mangatoon.mobi/ps/9/watermark/1000/Z.jpg">'
    expect(chapterImageUrls(html, 'https://mangatoon.mobi/en/watch/1/2')).toEqual(['https://en.mangatoon.mobi/ps/9/watermark/1000/Z.jpg', 'https://en.mangatoon.mobi/ps/9/watermark/1000/A.jpg'])
  })

  it('elsewhere keeps the folder with most pictures', () => {
    const html = '<img src="//cdn.site/logo.png"><img src="https://cdn.site/ch1/01.webp"><img src="https://cdn.site/ch1/02.webp">'
    expect(chapterImageUrls(html, 'https://site.com/read/1')).toEqual(['https://cdn.site/ch1/01.webp', 'https://cdn.site/ch1/02.webp'])
  })
})
