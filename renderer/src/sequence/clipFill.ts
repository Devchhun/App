import { EXPORT_ASPECT_RATIO_PARTS } from '@shared/export'
import type { BrandPreset } from '@shared/project'

/** The scale that makes a picture fill the whole frame (cover), cutting off
 * what does not fit -- every picture is first fitted inside the frame
 * (contain), so this is how much bigger it must then be. Null when the
 * picture's size is not known yet; 1 when it already fills the frame. */
export function clipFillScale(media: { width?: number; height?: number } | undefined, aspectRatio: BrandPreset['defaultAspectRatio']): number | null {
  if (!media?.width || !media.height) return null
  const [w, h] = EXPORT_ASPECT_RATIO_PARTS[aspectRatio]
  const frame = w / h
  const picture = media.width / media.height
  return Math.round((picture > frame ? picture / frame : frame / picture) * 1000) / 1000
}
