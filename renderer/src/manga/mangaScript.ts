import type { Scene } from '@shared/project'

/** The reason AI Manga gives its subtitle scenes (MangaPanel). */
export const MANGA_SUBTITLE_REASON = 'AI Manga narration'

/** An AI Manga recap as text for the Recap Script box: a paragraph per
 * picture's passage. */
export function mangaScriptFromPassages(passages: string[][]): string {
  return passages
    .map((lines) => lines.map((l) => l.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n\n')
}

/** The same from a project's AI Manga subtitles (one scene per sentence),
 * a new paragraph wherever a picture starts. For recaps made before AI
 * Manga wrote its script into the box. */
export function mangaScriptFromScenes(scenes: Array<Pick<Scene, 'startTime' | 'visualText' | 'reason'>>, pictureStarts: number[]): string {
  const lines = scenes.filter((s) => s.reason === MANGA_SUBTITLE_REASON && s.visualText.trim()).sort((a, b) => a.startTime - b.startTime)
  const passages: string[][] = []
  for (const line of lines) {
    const startsPicture = pictureStarts.some((t) => Math.abs(t - line.startTime) < 0.02)
    if (passages.length === 0 || startsPicture) passages.push([])
    passages[passages.length - 1].push(line.visualText)
  }
  return mangaScriptFromPassages(passages)
}
