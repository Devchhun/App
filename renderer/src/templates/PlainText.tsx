import type { CSSProperties } from 'react'
import { PLAIN_TEXT_DEFAULTS, plainTextLook } from '@shared/plainText'
import { SUBTITLE_FONT_FAMILY, SUBTITLE_LINE_HEIGHT } from '@shared/videoOverlay'
import type { TemplateProps } from './templateShared'
import { getPositionStyle, hexToRgba } from './templateShared'

/** Add Text's text: just the words -- no box unless the user turns one on --
 * in the same font and proportions Export burns in (shared/plainText.ts):
 * sizes are pixels of a 1080-pixel-tall frame, scaled to the Player. */
export function PlainText({ scene, motion, stageSize }: TemplateProps): JSX.Element {
  const look = plainTextLook(scene)
  const scale = (stageSize?.height ?? 1080) / 1080
  const fontSize = look.fontSizePx * scale
  const position = getPositionStyle(scene) ?? { left: '10%', top: '40%', width: '80%', height: '20%' }
  const justify = look.align === 'left' ? 'flex-start' : look.align === 'right' ? 'flex-end' : 'center'

  const text: CSSProperties = {
    fontFamily: `"${SUBTITLE_FONT_FAMILY}", "Leelawadee UI", sans-serif`,
    fontWeight: 700,
    fontSize,
    lineHeight: SUBTITLE_LINE_HEIGHT,
    color: look.color,
    whiteSpace: 'pre-wrap',
    textAlign: look.align
  }
  if (look.background) {
    // One box per line, like libass draws it (BorderStyle 3).
    const pad = look.boxPaddingEm * fontSize
    text.background = hexToRgba(look.backgroundColor, look.backgroundOpacity / 100)
    text.padding = `${pad}px`
    text.boxDecorationBreak = 'clone'
    text.WebkitBoxDecorationBreak = 'clone'
  } else if (look.strokeWidth > 0) {
    // Twice the width, painted under the fill: the outer half shows, the
    // same width libass's Outline puts around each letter.
    text.WebkitTextStroke = `${look.strokeWidth * 2 * scale}px ${look.strokeColor}`
    text.paintOrder = 'stroke fill'
  }
  if (look.shadow) text.textShadow = `${PLAIN_TEXT_DEFAULTS.shadowPx * scale}px ${PLAIN_TEXT_DEFAULTS.shadowPx * scale}px 0 rgba(0, 0, 0, 0.6)`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-plain-text"
      style={{ ...position, position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: justify, opacity: motion.opacity, transform: 'none', pointerEvents: 'auto' }}
    >
      <div style={{ maxWidth: '100%', textAlign: look.align }}>
        <span lang="km" style={text}>
          {scene.visualText}
        </span>
      </div>
    </div>
  )
}
