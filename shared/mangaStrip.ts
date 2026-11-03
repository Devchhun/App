/** Cutting a webtoon strip into scenes. A chapter comes as one long strip
 * (MangaToon serves it in 1000 x 1800 tiles whose edges fall anywhere,
 * mid-picture included); its scenes are separated by gutters -- bands of
 * one flat colour across the whole width. The strip is measured on a small
 * grey copy: for each row, how much it varies from side to side. */

export interface StripCutOptions {
  /** A row varying less than this (0-255 grey levels, standard deviation)
   * is flat: part of a gutter. */
  flatStd: number
  /** Rows of gutter needed for a cut, in the measured copy's rows (200 px
   * wide: 4 rows is about 20 px of a 1000 px strip). */
  minGutterRows: number
  /** Scenes shorter than this many times the strip's width join the next
   * (the last one joins the one before it). */
  minSceneRatio: number
  /** Scenes taller than this many times the width are split at their
   * flattest row; 0: never. */
  maxSceneRatio: number
}

/** The cut the user chose (2026-11-03): the first one, about 38 scenes for a
 * 27-tile chapter. Cutting only at wide gutters and never through a tall
 * picture (19 scenes, some 5 screens tall, scrolled) was tried and turned
 * down. */
export const DEFAULT_STRIP_CUT: StripCutOptions = { flatStd: 6, minGutterRows: 4, minSceneRatio: 0.3, maxSceneRatio: 2.2 }

/** Spread of each row of a grey image (row-major, `width` per row). */
export function rowStds(gray: Uint8Array, width: number): Float32Array {
  const height = Math.floor(gray.length / width)
  const out = new Float32Array(height)
  for (let y = 0; y < height; y++) {
    let sum = 0
    let sq = 0
    const at = y * width
    for (let x = 0; x < width; x++) {
      const v = gray[at + x]
      sum += v
      sq += v * v
    }
    const mean = sum / width
    out[y] = Math.sqrt(Math.max(0, sq / width - mean * mean))
  }
  return out
}

/** The scenes of a strip measured `width` wide, as [top, bottom) rows of
 * that measured copy: cut in the middle of every gutter, blank pieces
 * dropped, short pieces joined to the next, tall ones split where they are
 * flattest. */
export function findScenes(stds: Float32Array, width: number, options: StripCutOptions = DEFAULT_STRIP_CUT): Array<[number, number]> {
  const height = stds.length
  if (height === 0) return []
  const flat = (y: number): boolean => stds[y] < options.flatStd

  // Pieces between gutters (a gutter's rows belong to no piece).
  const pieces: Array<[number, number]> = []
  let y = 0
  let start = 0
  while (y < height) {
    if (!flat(y)) {
      y++
      continue
    }
    let end = y
    while (end < height && flat(end)) end++
    if (end - y >= options.minGutterRows || y === 0 || end === height) {
      if (y > start) pieces.push([start, y])
      start = end
    }
    y = end
  }
  if (start < height) pieces.push([start, height])

  // Too short: join to the next (a caption line above its picture).
  const minRows = Math.max(1, Math.round(width * options.minSceneRatio))
  const joined: Array<[number, number]> = []
  for (const piece of pieces) {
    const last = joined[joined.length - 1]
    if (last && last[1] - last[0] < minRows) last[1] = piece[1]
    else joined.push([...piece] as [number, number])
  }
  const tail = joined[joined.length - 1]
  if (joined.length > 1 && tail[1] - tail[0] < minRows) {
    joined.pop()
    joined[joined.length - 1][1] = tail[1]
  }

  if (!(options.maxSceneRatio > 0)) return joined
  // Too tall: split at the flattest row of its middle part, again and again.
  const maxRows = Math.max(minRows + 1, Math.round(width * options.maxSceneRatio))
  const out: Array<[number, number]> = []
  const split = (top: number, bottom: number): void => {
    if (bottom - top <= maxRows) {
      out.push([top, bottom])
      return
    }
    const from = top + Math.round((bottom - top) * 0.3)
    const to = top + Math.round((bottom - top) * 0.7)
    let best = from
    for (let r = from; r < to; r++) if (stds[r] < stds[best]) best = r
    split(top, best)
    split(best, bottom)
  }
  for (const [top, bottom] of joined) split(top, bottom)
  return out
}

/** One chapter in a comic's chapter list. */
export interface MangaEpisode {
  number: number
  title: string
  url: string
}

/** The comic's id in a MangaToon link: a chapter (/watch/<id>/<chapter>),
 * the comic's page (/detail/<id>) or a "?content_id=<id>" link; null for
 * any other site. */
export function mangatoonComicId(link: string): string | null {
  try {
    const url = new URL(link.trim())
    if (!/(^|\.)mangatoon\.mobi$/i.test(url.hostname)) return null
    return url.pathname.match(/\/(?:watch|detail)\/(\d+)/)?.[1] ?? url.searchParams.get('content_id')
  } catch {
    return null
  }
}

/** Where MangaToon lists every chapter of comic `id`, in the link's language. */
export function mangatoonEpisodesUrl(id: string, link: string): string {
  const url = new URL(link.trim())
  const language = /^\/([a-z]{2}(?:-[a-z]{2})?)\//i.exec(url.pathname)?.[1] ?? 'en'
  return `${url.origin}/${language}/detail/${id}/episodes`
}

/** The chapters on MangaToon's chapter list page, by number (each is listed
 * twice in the page, for phone and desktop). */
export function parseMangatoonEpisodes(html: string, id: string, origin: string): MangaEpisode[] {
  const seen = new Set<string>()
  const out: MangaEpisode[] = []
  const pattern = new RegExp(`<a[^>]*href="(/[a-z-]+/watch/${id}/(\\d+))"[^>]*>([\\s\\S]*?)</a>`, 'gi')
  for (const match of html.matchAll(pattern)) {
    const href = match[1]
    if (seen.has(href)) continue
    seen.add(href)
    const body = match[3]
    const number = Number(/episode-number[^>]*>\s*(\d+)\s*</i.exec(body)?.[1] ?? NaN)
    const titles = [...body.matchAll(/episode-title-new(?![^"]*episode-number)[^>]*>([^<]*)</gi)].map((m) => m[1].trim()).filter(Boolean)
    out.push({ number: Number.isFinite(number) ? number : out.length + 1, title: titles[0] ?? `Episode ${out.length + 1}`, url: `${origin}${href}` })
  }
  return out.sort((a, b) => a.number - b.number)
}

/** Image links of a chapter page, in reading order. MangaToon: the chapter's
 * own pictures (".../ps/<id>/watermark/<w>/<name>.jpg"), not its poster or
 * icons. Any other site: every picture link on the page, those from the
 * folder holding most of them (the chapter's), in page order. */
export function chapterImageUrls(html: string, pageUrl: string): string[] {
  const all: string[] = []
  const pattern = /(?:https?:)?\/\/[^"'\s()<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s()<>]*)?/gi
  for (const match of html.matchAll(pattern)) {
    const url = match[0].startsWith('//') ? `${new URL(pageUrl).protocol}${match[0]}` : match[0]
    if (!all.includes(url)) all.push(url)
  }
  const mangatoon = all.filter((u) => /\/ps\/\d+\/watermark\/\d+\//.test(u))
  if (mangatoon.length > 0) return mangatoon
  const folder = (u: string): string => u.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '')
  const counts = new Map<string, number>()
  for (const u of all) counts.set(folder(u), (counts.get(folder(u)) ?? 0) + 1)
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['']
  return all.filter((u) => folder(u) === best)
}
