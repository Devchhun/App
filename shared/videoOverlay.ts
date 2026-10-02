import type { TextOverlay } from './plainText'
/** Subtitles drawn on the video, and blur boxes over the original
 * (burned-in) subtitles -- the AI Dubber's "on video" settings, shown live
 * in the Player and burned in by Export. Every size and position is a
 * fraction of the frame, so one setting fits 16:9, 9:16 and any export
 * resolution alike. */

/** Ships in resources/fonts (OFL) and renderer/src/assets/fonts, so the
 * Player and the exported video use the very same Khmer font. */
export const SUBTITLE_FONT_FAMILY = 'Battambang'
/** libass sizes a font by its OS/2 win ascent + descent, a browser by its
 * em: for Battambang Bold that box is (2197 + 1051) / 2048 em tall, so an
 * ASS Fontsize of em x this draws the same size as CSS font-size em.
 * Measured before this: the exported text came out ~1.55x smaller than
 * the Player's. */
export const SUBTITLE_FONT_ASS_SCALE = (2197 + 1051) / 2048
/** The line box libass gives that font, in em -- the Player uses the same
 * line height so multi-line subtitles stack the same way. */
export const SUBTITLE_LINE_HEIGHT = SUBTITLE_FONT_ASS_SCALE

export interface SubtitleOverlayStyle {
  enabled: boolean
  /** Text height, % of the frame height. */
  fontSizePct: number
  /** #rrggbb */
  color: string
  outlineColor: string
  /** Outline thickness, % of the frame height (0 = none). */
  outlinePct: number
  /** A box behind the text instead of only an outline. */
  background: boolean
  backgroundColor: string
  /** 0-1 */
  backgroundOpacity: number
  /** Distance of the text's bottom from the frame's bottom, % of height. */
  bottomPct: number
  /** Where the text is centred across the frame, % of width (50 = middle). */
  xPct: number
}

export interface BlurRegion {
  id: string
  /** Left/top/width/height, fractions (0-1) of the frame. */
  x: number
  y: number
  w: number
  h: number
}

export interface BlurSettings {
  enabled: boolean
  /** Gaussian sigma in pixels of a 720-line frame (scaled to the actual
   * height, so a setting looks the same at any size). */
  strength: number
  regions: BlurRegion[]
}

export interface VideoOverlaySettings {
  subtitles: SubtitleOverlayStyle
  blur: BlurSettings
}

export function createDefaultVideoOverlaySettings(): VideoOverlaySettings {
  return {
    subtitles: {
      enabled: false,
      fontSizePct: 5.5,
      color: '#ffffff',
      outlineColor: '#000000',
      outlinePct: 0.35,
      background: false,
      backgroundColor: '#000000',
      backgroundOpacity: 0.55,
      bottomPct: 7,
      xPct: 50
    },
    // Where drama subtitles usually sit: a band across the lower part.
    blur: { enabled: false, strength: 14, regions: [{ id: 'blur-1', x: 0.1, y: 0.8, w: 0.8, h: 0.13 }] }
  }
}

/** Saved settings made whole again (a project from an older version, or a
 * hand-edited file): every field present and in range. */
export function sanitizeVideoOverlaySettings(saved: Partial<VideoOverlaySettings> | undefined): VideoOverlaySettings {
  const d = createDefaultVideoOverlaySettings()
  const s = { ...d.subtitles, ...(saved?.subtitles ?? {}) }
  const b = { ...d.blur, ...(saved?.blur ?? {}) }
  const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback)
  const hex = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback)
  return {
    subtitles: {
      enabled: !!s.enabled,
      fontSizePct: clamp(s.fontSizePct, 2, 15, d.subtitles.fontSizePct),
      color: hex(s.color, d.subtitles.color),
      outlineColor: hex(s.outlineColor, d.subtitles.outlineColor),
      outlinePct: clamp(s.outlinePct, 0, 2, d.subtitles.outlinePct),
      background: !!s.background,
      backgroundColor: hex(s.backgroundColor, d.subtitles.backgroundColor),
      backgroundOpacity: clamp(s.backgroundOpacity, 0, 1, d.subtitles.backgroundOpacity),
      bottomPct: clamp(s.bottomPct, 0, 90, d.subtitles.bottomPct),
      xPct: clamp(s.xPct, 10, 90, d.subtitles.xPct)
    },
    blur: {
      enabled: !!b.enabled,
      strength: clamp(b.strength, 1, 60, d.blur.strength),
      regions: (Array.isArray(b.regions) ? b.regions : d.blur.regions)
        .filter((r): r is BlurRegion => !!r && typeof r === 'object')
        .map((r, i) => clampRegion({ id: typeof r.id === 'string' ? r.id : `blur-${i + 1}`, x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }))
    }
  }
}

/** Smallest box side, as a fraction of the frame. */
const MIN_REGION = 0.02

/** A box kept inside the frame and not vanishingly small. */
export function clampRegion(region: BlurRegion): BlurRegion {
  const num = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback)
  const w = Math.min(1, Math.max(MIN_REGION, num(region.w, 0.8)))
  const h = Math.min(1, Math.max(MIN_REGION, num(region.h, 0.13)))
  const x = Math.min(1 - w, Math.max(0, num(region.x, 0.1)))
  const y = Math.min(1 - h, Math.max(0, num(region.y, 0.8)))
  return { ...region, x, y, w, h }
}

/** The side margins (% of width) that centre the text at `xPct`: text is
 * centred between them and wraps inside them -- the Player (CSS left/right)
 * and Export (ASS MarginL/MarginR) both use these, so a line breaks at the
 * same place in both. */
export function subtitleSideMarginsPct(xPct: number): { left: number; right: number } {
  const base = 5
  const shift = 2 * Math.min(90, Math.max(10, xPct)) - 100
  return shift >= 0 ? { left: base + shift, right: base } : { left: base, right: base - shift }
}

export interface OverlayLine {
  start: number
  end: number
  text: string
}

/** "#rrggbb" + opacity -> ASS "&HAABBGGRR" (ASS alpha: 00 opaque, FF clear). */
export function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ['', 'ff', 'ff', 'ff']
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
  const two = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
  return `&H${two(alpha)}${m[3].toUpperCase()}${m[2].toUpperCase()}${m[1].toUpperCase()}`
}

/** h:mm:ss.cc */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${h}:${two(m)}:${two(s)}.${two(c)}`
}

/** A line's text made safe for ASS: no override blocks, real line breaks. */
export function assText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\\/g, '＼')
    .replace(/\{/g, '（')
    .replace(/\}/g, '）')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\\N')
}

/** The subtitles as an ASS script sized to the export frame, styled the way
 * the Player draws them (SubtitleOverlay.tsx). */
export function buildAssSubtitles(lines: OverlayLine[], style: SubtitleOverlayStyle, frame: { width: number; height: number }): string {
  const H = frame.height
  const emPx = (style.fontSizePct / 100) * H
  const fontSize = Math.round(emPx * SUBTITLE_FONT_ASS_SCALE)
  const outline = Math.round((style.outlinePct / 100) * H * 10) / 10
  const marginV = Math.round((style.bottomPct / 100) * H)
  const sides = subtitleSideMarginsPct(style.xPct)
  const marginL = Math.round((sides.left / 100) * frame.width)
  const marginR = Math.round((sides.right / 100) * frame.width)
  // BorderStyle 3 = an opaque box (drawn in OutlineColour) behind the text.
  const borderStyle = style.background ? 3 : 1
  const outlineColour = style.background ? assColor(style.backgroundColor, style.backgroundOpacity) : assColor(style.outlineColor)
  const boxPadding = Math.max(2, Math.round(emPx * 0.18))
  const events = lines
    .filter((line) => line.end > line.start && line.text.trim())
    .sort((a, b) => a.start - b.start)
    .map((line) => `Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Default,,0,0,0,,${assText(line.text)}`)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${SUBTITLE_FONT_FAMILY},${fontSize},${assColor(style.color)},&H000000FF,${outlineColour},&H00000000,-1,0,0,0,100,100,0,0,${borderStyle},${style.background ? boxPadding : outline},0,2,${marginL},${marginR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n')
}

/** A path as an ffmpeg filter option value: quoted, with the drive colon
 * escaped (C\:/...) -- verified with the bundled ffmpeg on Windows. */
export function ffmpegFilterPath(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`
}

/** Even pixel counts: the frame is yuv420 (chroma in 2x2 blocks). */
const evenSize = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
const evenPos = (n: number): number => Math.max(0, Math.round(n / 2) * 2)

/** Filter-graph steps that blur the boxes and then draw the subtitles over
 * the composited frame `[input]`, ending at `[output]`. Empty when there is
 * nothing to add (the caller then keeps its own label). */
export function buildOverlayFilterSteps(
  input: string,
  output: string,
  frame: { width: number; height: number },
  overlay: { blur?: BlurSettings; assPath?: string; textAssPath?: string; fontsDir?: string }
): string[] {
  // The subtitles, then Add Text's texts over them.
  const assFiles = [overlay.assPath, overlay.textAssPath].filter((path): path is string => !!path)
  const steps: string[] = []
  let label = input
  const regions = overlay.blur?.enabled ? overlay.blur.regions.map(clampRegion) : []
  const sigma = Math.round(((overlay.blur?.strength ?? 0) * frame.height) / 720 * 10) / 10
  regions.forEach((region, i) => {
    const w = Math.min(frame.width, evenSize(region.w * frame.width))
    const h = Math.min(frame.height, evenSize(region.h * frame.height))
    const x = Math.min(frame.width - w, evenPos(region.x * frame.width))
    const y = Math.min(frame.height - h, evenPos(region.y * frame.height))
    const next = i === regions.length - 1 && assFiles.length === 0 ? output : `blurred${i}`
    steps.push(`[${label}]split=2[blurbg${i}][blurfg${i}]`)
    steps.push(`[blurfg${i}]crop=${w}:${h}:${x}:${y},gblur=sigma=${sigma}[blurbox${i}]`)
    steps.push(`[blurbg${i}][blurbox${i}]overlay=${x}:${y}[${next}]`)
    label = next
  })
  const fonts = overlay.fontsDir ? `:fontsdir=${ffmpegFilterPath(overlay.fontsDir)}` : ''
  assFiles.forEach((path, i) => {
    const next = i === assFiles.length - 1 ? output : `subtitled${i}`
    // `ass` with complex shaping: the default simple shaping drew Khmer
    // with every subscript (coeng) left apart -- unreadable.
    steps.push(`[${label}]ass=shaping=complex:filename=${ffmpegFilterPath(path)}${fonts}[${next}]`)
    label = next
  })
  return steps
}

/** What Export burns into the video (see buildOverlayFilterSteps). */
export interface ExportOverlay {
  subtitles?: { lines: OverlayLine[]; style: SubtitleOverlayStyle }
  blur?: BlurSettings
  /** Add Text's plain texts (shared/plainText.ts). */
  texts?: TextOverlay[]
}

/** The overlay worth sending to Export, or undefined when neither part is on. */
export function exportOverlayFor(settings: VideoOverlaySettings | undefined, lines: OverlayLine[]): ExportOverlay | undefined {
  if (!settings) return undefined
  const subtitles = settings.subtitles.enabled && lines.length > 0 ? { lines, style: settings.subtitles } : undefined
  const blur = settings.blur.enabled && settings.blur.regions.length > 0 ? settings.blur : undefined
  return subtitles || blur ? { subtitles, blur } : undefined
}
