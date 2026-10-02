// Shared clip-visual/volume resolution -- the SAME logic the main <video>
// element and every SecondaryTrackMedia instance both need, so a keyframed
// property behaves identically no matter which element is rendering that
// clip. Previously this transform/opacity style-building logic lived
// duplicated, nearly verbatim, in both PreviewPlayer.tsx call sites.
import type { TimelineClip } from '@shared/project'
import { interpolateKeyframes, isAnimated } from '@shared/keyframes'
import { clipMotionAt } from '@shared/clipMotion'

/** True if ANY property on this clip has enough keyframes to actually vary
 * over time -- lets a caller decide whether its style/volume computation
 * needs to re-run every frame (keyframed) or can stay memoized on clip
 * identity alone (today's exact behavior for a plain, unkeyframed clip). */
export function clipHasAnimatedProperties(clip: TimelineClip | undefined): boolean {
  if (clip?.motion) return true
  if (!clip?.keyframes) return false
  return Object.values(clip.keyframes).some((keyframes) => isAnimated(keyframes))
}

/** Opacity + transform/crop CSS for `clip` at `timeWithinClip` (seconds from
 * the clip's own start -- matches ClipKeyframe.time's convention exactly,
 * and is the same `elapsed` quantity the fade-volume computation already
 * derives). Each field falls back to its plain static value when
 * unkeyframed, so a clip with no keyframes at all produces byte-for-byte
 * the same style object as before this feature existed. */
export function computeClipVisualStyle(
  clip: TimelineClip | undefined,
  timeWithinClip: number,
  /** The Player's picture in pixels: a clip's motion (shared/clipMotion.ts)
   * moves by fractions of it, as Export moves by fractions of the frame. */
  frame?: { width: number; height: number } | null,
  /** The media's own pixel size: the picture is fitted into the frame
   * (object-fit: contain) and scaled -- what edge-to-edge motion needs. */
  mediaSize?: { width?: number; height?: number }
): React.CSSProperties {
  if (!clip) return {}
  const kf = clip.keyframes
  const t = clip.transform
  const style: React.CSSProperties = {}

  const opacity = interpolateKeyframes(kf?.opacity, timeWithinClip, clip.opacity ?? 1)
  if (clip.opacity !== undefined || isAnimated(kf?.opacity)) style.opacity = opacity

  let picture: { width: number; height: number } | undefined
  if (frame && mediaSize?.width && mediaSize.height) {
    const fit = Math.min(frame.width / mediaSize.width, frame.height / mediaSize.height)
    picture = { width: mediaSize.width * fit * Math.abs(t?.scaleX ?? 1), height: mediaSize.height * fit * Math.abs(t?.scaleY ?? 1) }
  }
  const motion = clip.motion && frame ? clipMotionAt(clip.motion, timeWithinClip, frame, picture) : null
  const hasTransform =
    !!motion ||
    !!t ||
    isAnimated(kf?.x) ||
    isAnimated(kf?.y) ||
    isAnimated(kf?.scaleX) ||
    isAnimated(kf?.scaleY) ||
    isAnimated(kf?.rotation) ||
    isAnimated(kf?.cropTop) ||
    isAnimated(kf?.cropRight) ||
    isAnimated(kf?.cropBottom) ||
    isAnimated(kf?.cropLeft)
  if (hasTransform) {
    const x = interpolateKeyframes(kf?.x, timeWithinClip, t?.x ?? 0)
    const y = interpolateKeyframes(kf?.y, timeWithinClip, t?.y ?? 0)
    const scaleX = interpolateKeyframes(kf?.scaleX, timeWithinClip, t?.scaleX ?? 1)
    const scaleY = interpolateKeyframes(kf?.scaleY, timeWithinClip, t?.scaleY ?? 1)
    const rotation = interpolateKeyframes(kf?.rotation, timeWithinClip, t?.rotation ?? 0)
    const m = motion ?? { dx: 0, dy: 0, scale: 1, rotate: 0 }
    style.transform = `translate(${x + m.dx}px, ${y + m.dy}px) scale(${scaleX * m.scale}, ${scaleY * m.scale}) rotate(${rotation + m.rotate}deg)`

    const top = interpolateKeyframes(kf?.cropTop, timeWithinClip, t?.cropTop ?? 0) * 100
    const right = interpolateKeyframes(kf?.cropRight, timeWithinClip, t?.cropRight ?? 0) * 100
    const bottom = interpolateKeyframes(kf?.cropBottom, timeWithinClip, t?.cropBottom ?? 0) * 100
    const left = interpolateKeyframes(kf?.cropLeft, timeWithinClip, t?.cropLeft ?? 0) * 100
    if (top || right || bottom || left) style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`
  }

  return style
}

/** The clip's own volume at `timeWithinClip` -- keyframed if `keyframes.volume`
 * has 2+ points, else the plain static `clip.volume` (default 1), exactly
 * as before this feature existed. Multiply this into the SAME
 * fade/mute/track-mute computation every volume call site already does --
 * this only resolves the clip's OWN volume value, not the final mixed
 * output. */
export function resolveClipVolume(clip: TimelineClip | undefined, timeWithinClip: number): number {
  return interpolateKeyframes(clip?.keyframes?.volume, timeWithinClip, clip?.volume ?? 1)
}
