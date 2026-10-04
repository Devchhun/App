import type { ClipTransform } from '@shared/project'
import { POSITION_REFERENCE_SHORT_SIDE } from '@shared/clipPosition'

/** How wide the logo is, as a part of the frame's width, by frame shape. */
const LOGO_WIDTH: Record<'16:9' | '9:16' | '1:1', number> = { '16:9': 0.2, '9:16': 0.42, '1:1': 0.3 }
/** Gap to the frame's top and right edges, as a part of its short side. */
const LOGO_MARGIN = 0.04

/** The frame in Position's reference units (shared/clipPosition.ts). */
function referenceFrame(aspect: '16:9' | '9:16' | '1:1'): { width: number; height: number } {
  const s = POSITION_REFERENCE_SHORT_SIDE
  return aspect === '16:9' ? { width: (s * 16) / 9, height: s } : aspect === '9:16' ? { width: s, height: (s * 16) / 9 } : { width: s, height: s }
}

/** Size and place a logo of this shape in the frame's top-right corner. */
export function logoCornerTransform(media: { width: number; height: number }, aspect: '16:9' | '9:16' | '1:1'): Pick<ClipTransform, 'x' | 'y' | 'scaleX' | 'scaleY'> {
  const frame = referenceFrame(aspect)
  // The picture's size at scale 1: fitted whole into the frame.
  const fit = Math.min(frame.width / media.width, frame.height / media.height)
  const fittedW = media.width * fit
  const targetW = frame.width * LOGO_WIDTH[aspect]
  const scale = targetW / fittedW
  const w = targetW
  const h = media.height * fit * scale
  const margin = Math.min(frame.width, frame.height) * LOGO_MARGIN
  return { scaleX: scale, scaleY: scale, x: frame.width / 2 - margin - w / 2, y: -frame.height / 2 + margin + h / 2 }
}
