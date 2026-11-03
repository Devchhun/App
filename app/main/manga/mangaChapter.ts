import { app } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { chapterImageUrls, findScenes, mangatoonComicId, mangatoonEpisodesUrl, parseMangatoonEpisodes, rowStds, type MangaEpisode } from '@shared/mangaStrip'
import { CanceledError, runFfmpeg } from '../media/jobRunner'
import { probeMedia } from '../media/probe'

/** AI Manga's chapter tools: a chapter page's pictures downloaded in reading
 * order, and a webtoon strip cut into scenes at its gutters (see
 * shared/mangaStrip.ts). Everything is kept under userData/manga -- the
 * scenes become Timeline media, so never the temp folder. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
/** The strip is measured this many pixels wide. */
const MEASURE_WIDTH = 200
const DOWNLOADS_AT_ONCE = 4

export function mangaDir(): string {
  return join(app.getPath('userData'), 'manga')
}

async function newFolder(name: string): Promise<string> {
  const dir = join(mangaDir(), `${name}-${Date.now().toString(36)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** A folder name from the link: "mangatoon-2858198-151259". */
function folderName(pageUrl: string): string {
  try {
    const url = new URL(pageUrl)
    const host = url.hostname.replace(/^www\./, '').split('.')[0]
    const digits = url.pathname.match(/\d+/g)?.slice(-2).join('-')
    return [host, digits].filter(Boolean).join('-').replace(/[^\w-]/g, '').slice(0, 60) || 'chapter'
  } catch {
    return 'chapter'
  }
}

/** Every chapter of the comic a MangaToon link belongs to, in order. */
export async function listEpisodes(link: string, signal?: AbortSignal): Promise<{ title: string; episodes: MangaEpisode[] }> {
  const id = mangatoonComicId(link)
  if (!id) throw new Error('Chapters from..to work with MangaToon links. For another site, get each chapter by its own link.')
  const url = mangatoonEpisodesUrl(id, link)
  const page = await fetch(url, { headers: { 'User-Agent': UA }, signal, redirect: 'follow' })
  if (!page.ok) throw new Error(`The chapter list did not open (${page.status}).`)
  const html = await page.text()
  const episodes = parseMangatoonEpisodes(html, id, new URL(url).origin)
  if (episodes.length === 0) throw new Error('No chapters were found for this comic.')
  const title = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s*-\s*MangaToon.*$/i, '').replace(/^Read\s+/i, '').trim()
  return { title, episodes }
}

export async function downloadChapter(pageUrl: string, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<{ title: string; paths: string[] }> {
  let url: URL
  try {
    url = new URL(pageUrl.trim())
  } catch {
    throw new Error('Paste the link of a chapter page (starting with https://).')
  }
  const page = await fetch(url, { headers: { 'User-Agent': UA }, signal })
  if (!page.ok) throw new Error(`The chapter page did not open (${page.status}).`)
  const html = await page.text()
  const urls = chapterImageUrls(html, url.href)
  if (urls.length === 0) throw new Error('No pictures were found on that page. Open the chapter itself (the page you read it on) and copy its link.')
  const title = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s*-\s*MangaToon.*$/i, '').trim()

  const dir = await newFolder(folderName(url.href))
  const paths: string[] = new Array(urls.length)
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const i = next++
      if (signal.aborted) throw new CanceledError()
      const ext = /\.(png|webp|jpe?g)/i.exec(urls[i])?.[1]?.toLowerCase().replace('jpeg', 'jpg') ?? 'jpg'
      let last: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(urls[i], { headers: { 'User-Agent': UA, Referer: url.href }, signal })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const path = join(dir, `${String(i + 1).padStart(3, '0')}.${ext}`)
          await writeFile(path, Buffer.from(await res.arrayBuffer()))
          paths[i] = path
          last = null
          break
        } catch (error) {
          if (signal.aborted) throw new CanceledError()
          last = error
        }
      }
      if (last) throw new Error(`Picture ${i + 1} of ${urls.length} could not be downloaded: ${last instanceof Error ? last.message : String(last)}`)
      onProgress(++done, urls.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, urls.length) }, worker))
  return { title, paths }
}

/** One picture as grey rows MEASURE_WIDTH wide: its row spreads. */
async function measure(jobId: string, path: string, rows: number): Promise<Float32Array> {
  const { stdout } = await runFfmpeg(jobId, ['-v', 'error', '-i', path, '-vf', `scale=${MEASURE_WIDTH}:${rows}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { captureStdout: true })
  return rowStds(new Uint8Array(stdout ?? Buffer.alloc(0)), MEASURE_WIDTH)
}

/** The pictures in order, joined into one strip and cut into scenes at its
 * gutters; returns the scene files. Pictures of different widths are
 * brought to the first one's width. */
export async function cutIntoScenes(jobId: string, paths: string[], onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<string[]> {
  if (paths.length === 0) return []
  const sizes = await Promise.all(paths.map(async (p) => {
    const m = await probeMedia(p)
    if (!m.width || !m.height) throw new Error(`Could not read the picture ${p}.`)
    return { w: m.width, h: m.height }
  }))
  const width = sizes[0].w
  // Each picture's height at the strip's width (full) and measured.
  const full = sizes.map((s) => Math.max(1, Math.round((s.h * width) / s.w)))
  const small = sizes.map((s) => Math.max(1, Math.round((s.h * MEASURE_WIDTH) / s.w)))
  const fullTop: number[] = []
  const smallTop: number[] = []
  full.reduce((at, h, i) => ((fullTop[i] = at), at + h), 0)
  small.reduce((at, h, i) => ((smallTop[i] = at), at + h), 0)

  const parts: Float32Array[] = []
  for (const [i, path] of paths.entries()) {
    if (signal.aborted) throw new CanceledError()
    parts.push(await measure(`${jobId}:measure:${i}`, path, small[i]))
    onProgress(i + 1, paths.length * 2)
  }
  const stds = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (stds.set(p, at), at + p.length), 0)
  const scenes = findScenes(stds, MEASURE_WIDTH)

  // A measured row -> its row in the full-size strip.
  const toFull = (row: number): number => {
    let i = smallTop.length - 1
    while (i > 0 && smallTop[i] > row) i--
    return Math.round(fullTop[i] + ((row - smallTop[i]) / small[i]) * full[i])
  }
  const dir = await newFolder('scenes')
  const out: string[] = []
  for (const [n, [a, b]] of scenes.entries()) {
    if (signal.aborted) throw new CanceledError()
    const top = toFull(a)
    const bottom = Math.min(toFull(b), fullTop[fullTop.length - 1] + full[full.length - 1])
    if (bottom - top < 8) continue
    // The pictures this scene runs across, stacked, then cut out.
    const first = fullTop.findIndex((t, i) => t + full[i] > top)
    let last = first
    while (last + 1 < paths.length && fullTop[last + 1] < bottom) last++
    const inputs = paths.slice(first, last + 1).flatMap((p) => ['-i', p])
    const scaled = paths.slice(first, last + 1).map((_, k) => `[${k}:v]scale=${width}:${full[first + k]},setsar=1,format=rgb24[s${k}]`)
    const stack = last > first ? `${scaled.map((_, k) => `[s${k}]`).join('')}vstack=inputs=${last - first + 1}[st];[st]` : '[s0]'
    const filter = `${scaled.join(';')};${stack}crop=${width}:${bottom - top}:0:${top - fullTop[first]}[out]`
    const path = join(dir, `scene-${String(out.length + 1).padStart(3, '0')}.jpg`)
    await runFfmpeg(`${jobId}:scene:${n}`, ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-q:v', '2', path])
    out.push(path)
    onProgress(paths.length + Math.round(((n + 1) / scenes.length) * paths.length), paths.length * 2)
  }
  return out
}

/** "3 side by side" backdrops: each picture filling a 1920 x 1080 frame,
 * blurred and darkened, as a JPEG the Timeline shows like any picture (so
 * Export draws it the same, no blur of its own needed). */
export async function makeBackdrops(jobId: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const dir = await newFolder('backdrops')
  const out: string[] = []
  for (const [i, path] of paths.entries()) {
    const target = join(dir, `backdrop-${String(i + 1).padStart(3, '0')}.jpg`)
    await runFfmpeg(`${jobId}:backdrop:${i}`, ['-y', '-v', 'error', '-i', path, '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,eq=brightness=-0.25', '-frames:v', '1', '-q:v', '3', target])
    out.push(target)
  }
  return out
}
