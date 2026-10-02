// Add Text's plain text: how it looks (shared by the Player's PlainText
// template and Export) and its ASS script, so what Export burns in is what
// the Player showed. Sizes are pixels of a 1080-pixel-tall frame.
import type { Scene } from './project'
import type { TextAlign } from './templates'
import { assText, assTime, SUBTITLE_FONT_ASS_SCALE, SUBTITLE_FONT_FAMILY } from './videoOverlay'

export const PLAIN_TEXT_DEFAULTS = {
  fontSizePx: 72,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 3,
  shadow: true,
  backgroundColor: '#000000',
  backgroundOpacity: 70,
  /** Box padding around the words, in em (libass pads a box evenly). */
  boxPaddingEm: 0.18,
  shadowPx: 3
}

export interface PlainTextLook {
  fontSizePx: number
  color: string
  align: TextAlign
  strokeColor: string
  /** 0 = no outline. Ignored with a background (the box replaces it). */
  strokeWidth: number
  shadow: boolean
  background: boolean
  backgroundColor: string
  /** 0-100. */
  backgroundOpacity: number
  boxPaddingEm: number
}

export type PlainTextStyleFields = Pick<
  Scene,
  'fontSizePx' | 'textColor' | 'textAlign' | 'textStrokeColor' | 'textStrokeWidth' | 'textShadow' | 'textBackground' | 'fillColor' | 'fillOpacity'
>

export function plainTextLook(scene: PlainTextStyleFields): PlainTextLook {
  const d = PLAIN_TEXT_DEFAULTS
  return {
    fontSizePx: scene.fontSizePx ?? d.fontSizePx,
    color: scene.textColor ?? d.color,
    align: scene.textAlign ?? 'center',
    strokeColor: scene.textStrokeColor ?? d.strokeColor,
    strokeWidth: scene.textStrokeWidth ?? d.strokeWidth,
    shadow: scene.textShadow ?? d.shadow,
    background: scene.textBackground ?? false,
    backgroundColor: scene.fillColor ?? d.backgroundColor,
    backgroundOpacity: scene.fillOpacity ?? d.backgroundOpacity,
    boxPaddingEm: d.boxPaddingEm
  }
}

/** One plain text to burn into an export: Timeline seconds, its box as
 * percentages of the frame, its look, and its fade in/out. */
export interface TextOverlay {
  start: number
  end: number
  text: string
  position: { xPct: number; yPct: number; widthPct: number; heightPct: number }
  look: PlainTextLook
  fadeInSeconds: number
  fadeOutSeconds: number
}

/** The default box: centred, most of the width. */
export const PLAIN_TEXT_POSITION = { xPct: 10, yPct: 40, widthPct: 80, heightPct: 20 }

/** "#rrggbb" -> an ASS override colour "&HBBGGRR&". */
function tagColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ['', 'ff', 'ff', 'ff']
  return `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase()
}

/** 0-1 opacity -> an ASS override alpha "&HAA&" (00 opaque). */
function tagAlpha(opacity: number): string {
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
  return `&H${a.toString(16).toUpperCase().padStart(2, '0')}&`
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** The texts as one ASS script for the export frame. Each text sits at the
 * middle of its box (left/centre/right as aligned), wraps inside the box's
 * width, and fades in and out. Two styles: letters with an outline, and
 * letters on a box (an ASS box cannot be switched on per line). */
export function buildAssTexts(texts: TextOverlay[], frame: { width: number; height: number }): string {
  const W = frame.width
  const H = frame.height
  const s = H / 1080
  const events = texts
    .filter((t) => t.end > t.start && t.text.trim())
    .sort((a, b) => a.start - b.start)
    .map((t) => {
      const { look } = t
      const em = look.fontSizePx * s
      const left = (t.position.xPct / 100) * W
      const right = ((t.position.xPct + t.position.widthPct) / 100) * W
      const centreY = ((t.position.yPct + t.position.heightPct / 2) / 100) * H
      const x = look.align === 'left' ? left : look.align === 'right' ? right : (left + right) / 2
      const an = look.align === 'left' ? 4 : look.align === 'right' ? 6 : 5
      const fadeIn = Math.round(Math.max(0, Math.min(t.fadeInSeconds, (t.end - t.start) / 2)) * 1000)
      const fadeOut = Math.round(Math.max(0, Math.min(t.fadeOutSeconds, (t.end - t.start) / 2)) * 1000)
      const tags = [`\\an${an}`, `\\pos(${Math.round(x)},${Math.round(centreY)})`, `\\fs${round1(em * SUBTITLE_FONT_ASS_SCALE)}`, `\\c${tagColor(look.color)}`]
      if (look.background) {
        tags.push(`\\bord${round1(look.boxPaddingEm * em)}`, `\\3c${tagColor(look.backgroundColor)}`, `\\3a${tagAlpha(look.backgroundOpacity / 100)}`)
      } else {
        tags.push(`\\bord${round1(look.strokeWidth * s)}`, `\\3c${tagColor(look.strokeColor)}`)
      }
      tags.push(look.shadow ? `\\shad${round1(PLAIN_TEXT_DEFAULTS.shadowPx * s)}` : '\\shad0', '\\4c&H000000&', `\\4a${tagAlpha(0.6)}`)
      if (fadeIn || fadeOut) tags.push(`\\fad(${fadeIn},${fadeOut})`)
      // The box's own sides are the margins the words wrap inside.
      const marginL = Math.max(0, Math.round(left))
      const marginR = Math.max(0, Math.round(W - right))
      return `Dialogue: 0,${assTime(t.start)},${assTime(t.end)},${look.background ? 'Box' : 'Text'},,${marginL},${marginR},0,,{${tags.join('')}}${assText(t.text)}`
    })
  const style = (name: string, borderStyle: number): string =>
    `Style: ${name},${SUBTITLE_FONT_FAMILY},${round1(PLAIN_TEXT_DEFAULTS.fontSizePx * s * SUBTITLE_FONT_ASS_SCALE)},&H00FFFFFF,&H000000FF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,${borderStyle},0,0,5,0,0,0,1`
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Text', 1),
    style('Box', 3),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n')
}
