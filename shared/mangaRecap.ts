/** AI Manga (right sidebar tab): already-cut manga panels in, a narrated
 * story recap on the Timeline out. Gemini reads the whole chapter's panels
 * and retells it as one connected recap, a passage for each group of panels
 * shown together (3 side by side, or 1); KiriTTS speaks each passage, and
 * each group stays on screen exactly as long as its passage. See
 * app/main/manga/mangaRecapService.ts and renderer/src/manga/. */

export const MANGA_IPC = {
  pickImages: 'manga:pick-images',
  /** A chapter page's pictures, downloaded and cut into scenes. */
  getChapter: 'manga:get-chapter',
  /** Pictures (a webtoon strip) joined and cut into scenes. */
  cutScenes: 'manga:cut-scenes',
  /** Blurred 16:9 backdrops for "3 side by side". */
  backdrops: 'manga:backdrops',
  /** Picture paths -> app-media:// links, for the panel grid. */
  thumbs: 'manga:thumbs',
  /** A MangaToon link -> every chapter of its comic. */
  episodes: 'manga:episodes',
  generate: 'manga:generate',
  cancel: 'manga:cancel',
  progress: 'manga:progress'
} as const

export type MangaLanguage = 'km' | 'en'

export interface MangaRequest {
  jobId: string
  /** The panels, in reading order. */
  imagePaths: string[]
  /** KiriTTS voice id (without the AI Dubber's "kiri:" prefix). */
  voice: string
  language: MangaLanguage
  /** Optional: title, character names, what came before. */
  notes: string
  /** Panels shown together and narrated as one passage: 3 (side by side) or
   * 1 (one at a time). */
  groupSize?: number
  /** The frame the panels are shown in. */
  aspect?: '16:9' | '9:16' | '1:1'
  /** Several chapters in one video: the story told in the chapters before
   * (MangaResult.storySoFar of the last one), so names and threads carry
   * on; `continues` (not the first chapter: no opening hook) and `more`
   * (not the last: no "next episode" ending, it runs straight on). */
  storySoFar?: string
  continues?: boolean
  more?: boolean
}

export type MangaEpisodesResult = { ok: true; title: string; episodes: Array<{ number: number; title: string; url: string }> } | { ok: false; error: string }

/** One sentence of a panel's narration, in seconds from the panel's start. */
export interface MangaLine {
  text: string
  start: number
  end: number
}

/** A group of panels on screen together and the passage told over it. */
export interface MangaGroupResult {
  imagePaths: string[]
  /** Where the action is in each picture, 0-1 from the left / the top (the
   * slow pan of a panel shown alone drifts towards it). */
  focus: Array<{ x: number; y: number }>
  /** The passage's voice (WAV), kept with the app's data. */
  audioPath: string
  /** Length of that voice, in seconds. */
  audioSeconds: number
  /** Silence after the voice before the next group (see joinPause). */
  pauseAfter?: number
  lines: MangaLine[]
  /** How each picture's character moves, and its cut-out (a PNG with the
   * background taken away), or null when it stays still. */
  motions?: MangaMotion[]
  cutouts?: Array<string | null>
}

export interface MangaResult {
  title: string
  groups: MangaGroupResult[]
  /** Groups whose voice could not be made (shown silently). */
  skipped: number
  /** Pictures left out for being only words (a caption, a bubble). */
  leftOut?: number
  /** All the passages joined into one file, in order: a group without a
   * voice is MANGA_SILENT_PANEL_SECONDS of silence in it. One clip plays as
   * one continuous read -- a clip per panel made the Player load a new file
   * at every cut, and the narration stuttered. */
  narrationPath?: string
  /** The story up to the end of this chapter, in English, for the next. */
  storySoFar?: string
}

/** The paths in groups of `size`, in order (the last may be smaller). */
export function groupPaths<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

export type MangaIpcResult = { ok: true; data: MangaResult } | { ok: false; error: string; canceled?: boolean }

export type MangaPhase = 'downloading' | 'cutting' | 'reading' | 'writing' | 'characters' | 'voicing'

export type MangaScenesResult = { ok: true; title: string; paths: string[] } | { ok: false; error: string; canceled?: boolean }

export interface MangaProgress {
  jobId: string
  phase: MangaPhase
  percent: number
  message: string
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Reading order from file names: "page2" before "page10", as a person
 * numbers panels. */
export function sortPanelPaths(paths: string[]): string[] {
  const name = (p: string): string => p.split(/[\\/]/).pop() ?? p
  return [...paths].sort((a, b) => collator.compare(name(a), name(b)) || collator.compare(a, b))
}

/** A panel's sentences timed across its voice by length: a longer sentence
 * takes longer to say. Khmer has no spaces between words, so characters
 * (without spaces) are the measure. */
export function timeLines(sentences: string[], seconds: number): MangaLine[] {
  const texts = sentences.map((s) => s.trim()).filter(Boolean)
  if (texts.length === 0 || !(seconds > 0)) return []
  const weights = texts.map((t) => Math.max(1, t.replace(/\s+/g, '').length))
  const total = weights.reduce((sum, w) => sum + w, 0)
  let at = 0
  return texts.map((text, i) => {
    const start = at
    at = i === texts.length - 1 ? seconds : at + (seconds * weights[i]) / total
    return { text, start: round3(start), end: round3(at) }
  })
}

function round3(n: number): number {
  // + 0 turns -0 into 0.
  return Math.round(n * 1000) / 1000 + 0
}

/** Silence after each panel's voice before the next panel comes in, when
 * its own end is not measured: none. */
export const MANGA_PANEL_GAP_SECONDS = 0

/** The least quiet between two panels' voices. 0: the user wants the
 * voices straight on, nothing added (2026-11-03; 0.3 s of breath at every
 * join was tried and turned down). */
export const MANGA_JOIN_PAUSE_SECONDS = 0

/** Silence to add after a voice that already ends in `trailingSilence`
 * seconds of quiet, so the join has at least `target` of quiet. */
export function joinPause(trailingSilence: number, target = MANGA_JOIN_PAUSE_SECONDS): number {
  return Math.round(Math.max(0, target - Math.max(0, trailingSilence)) * 1000) / 1000 + 0
}

/** Faster than this many characters (no spaces) a second, a voice was cut
 * short: KiriTTS sometimes returns a fraction of a passage (EP1, 2026-11-04:
 * 152 characters in 0.64 s; a whole read runs at 15-21). It is asked again. */
export const MANGA_MAX_CHARS_PER_SECOND = 30

export function voiceCutShort(text: string, seconds: number): boolean {
  const chars = text.replace(/\s+/g, '').length
  return seconds > 0 && chars >= 20 && chars / seconds > MANGA_MAX_CHARS_PER_SECOND
}

/** A Khmer line without a name repeated in Latin letters, "យេ ធាន (Ye
 * Tian)": the Khmer voice reads Latin letters badly. */
export function withoutLatinAsides(line: string): string {
  return line.replace(/\s*[(（][^()（）]*[A-Za-z][^()（）]*[)）]/g, '').trim()
}

/** How long a panel without a voice stays on screen (silence in the joined
 * narration). */
export const MANGA_SILENT_PANEL_SECONDS = 2.5

/** A panel's length on the Timeline: its voice and the pause after it. */
export function panelSeconds(audioSeconds: number, pauseAfter = MANGA_PANEL_GAP_SECONDS): number {
  return audioSeconds > 0 ? audioSeconds + pauseAfter : MANGA_SILENT_PANEL_SECONDS
}

/** The panel's fixed zoom: enough picture past the frame to pan across. */
export const MANGA_ZOOM = 1.08

/** The slow pan of one panel, in Position units (shared/clipPosition.ts):
 * from the middle towards the action, never past the picture's edge. The
 * picture is fitted into the frame and zoomed by MANGA_ZOOM; only the part
 * that overflows the frame can be panned across. */
export function panelPan(
  media: { width?: number; height?: number },
  aspect: '16:9' | '9:16' | '1:1',
  focusX: number,
  focusY: number
): { endX: number; endY: number } {
  const frame = aspect === '9:16' ? { w: 1080, h: 1920 } : aspect === '1:1' ? { w: 1080, h: 1080 } : { w: 1920, h: 1080 }
  const mw = media.width ?? 0
  const mh = media.height ?? 0
  if (!(mw > 0 && mh > 0)) return { endX: 0, endY: 0 }
  const fit = Math.min(frame.w / mw, frame.h / mh)
  const pw = mw * fit * MANGA_ZOOM
  const ph = mh * fit * MANGA_ZOOM
  const room = (picture: number, side: number): number => Math.max(0, (picture - side) / 2)
  const clamp = (v: number, max: number): number => Math.max(-max, Math.min(max, v))
  const fx = Number.isFinite(focusX) ? Math.max(0, Math.min(1, focusX)) : 0.5
  const fy = Number.isFinite(focusY) ? Math.max(0, Math.min(1, focusY)) : 0.5
  // Moving the picture left (negative x) brings its right side into view.
  return { endX: round3(clamp(-(fx - 0.5) * pw, room(pw, frame.w))), endY: round3(clamp(-(fy - 0.5) * ph, room(ph, frame.h))) }
}

/** "3 side by side" (16:9 only): the panels go up three at a time, side by
 * side, all three in full view, on a blurred picture of the group's first
 * panel, while one passage tells that part of the story. A webtoon panel is
 * tall and narrow -- alone in a 16:9 frame it was either tiny or cut to a
 * sliver. (Dimming the two not being told about was tried and turned
 * down: the user wants all three seen.) */
export type MangaLayout = 'single' | 'trio'
export const MANGA_TRIO_SIZE = 3
/** A column's picture box on the 1920 x 1080 reference frame: a third of
 * the width, less a margin all round. */
const TRIO_COLUMN = 640
const TRIO_BOX = { w: 600, h: 1000 }

/** Where a panel sits in column `column` (0-2): its Position x and its
 * scale, relative to how the Player fits a picture into the whole frame. */
export function trioPlacement(media: { width?: number; height?: number }, column: number): { x: number; scale: number } {
  const mw = media.width ?? 0
  const mh = media.height ?? 0
  const x = (column - 1) * TRIO_COLUMN
  if (!(mw > 0 && mh > 0)) return { x, scale: 1 / 3 }
  const whole = Math.min(1920 / mw, 1080 / mh)
  const box = Math.min(TRIO_BOX.w / mw, TRIO_BOX.h / mh)
  return { x, scale: Math.round((box / whole) * 10000) / 10000 }
}

/** Between two scenes the frame dips to dark for a moment -- each picture
 * fades out over this long and the next fades in (TimelineClip.pictureFadeIn
 * / pictureFadeOut) -- instead of cutting hard. The user's reference channel
 * (2026-11-04, a Khmer manhwa recap) joins its panels this way: about a
 * quarter of a second down, a quarter up. */
export const MANGA_DIP_SECONDS = 0.25

/** How a scene's cut-out character moves (the picture behind stays still --
 * a moving picture was hard to watch): breathing when calm or talking,
 * floating when flying or in magic, a small tremble in a fight or a shock;
 * none when there is no character to cut out. Gemini picks one per scene. */
export const MANGA_MOTIONS = ['none', 'breathe', 'float', 'shake'] as const
export type MangaMotion = (typeof MANGA_MOTIONS)[number]

/** The cut-out is drawn this much larger than the character in the picture
 * behind it, so its small moves never show the original's outline. */
export const MANGA_CUTOUT_SCALE = 1.025

/** The clip motion (shared/clipMotion.ts) behind each kind: small and slow,
 * so the character seems alive rather than sliding about. */
export function mangaClipMotion(kind: MangaMotion | undefined): { preset: 'pulse' | 'float' | 'shake'; speed: number; amount: number } | null {
  switch (kind) {
    case 'breathe':
      return { preset: 'pulse', speed: 0.5, amount: 0.1 }
    case 'float':
      return { preset: 'float', speed: 0.5, amount: 0.12 }
    case 'shake':
      return { preset: 'shake', speed: 0.6, amount: 0.3 }
    default:
      return null
  }
}

/** Whether a cut-out (its RGBA pixels, measured small) is a character
 * worth moving. Not: next to nothing (a word of a caption), nearly the whole
 * picture, mostly see-through haze -- IS-Net, unsure what the subject is,
 * leaves a half-transparent ghost of the picture (EP1: a strip of eyes,
 * scraps of a monster) -- or mostly white: a speech bubble taken for the
 * subject. Moving any of those about looked broken. */
export function isGoodCutout(rgba: ArrayLike<number>): boolean {
  const pixels = Math.floor(rgba.length / 4)
  if (pixels === 0) return false
  let half = 0
  let solid = 0
  let soft = 0
  let white = 0
  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3]
    if (a > 128) half++
    if (a > 224) {
      solid++
      if (Math.min(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 225) white++
    } else if (a > 32) soft++
  }
  const share = half / pixels
  return share >= 0.08 && share <= 0.85 && soft / Math.max(1, solid + soft) <= 0.65 && white / Math.max(1, solid) <= 0.6
}

export function asMangaMotion(value: unknown): MangaMotion {
  return (MANGA_MOTIONS as readonly string[]).includes(String(value)) ? (value as MangaMotion) : 'none'
}
