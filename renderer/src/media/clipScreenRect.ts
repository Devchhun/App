import type { ClipTransform, TimelineClip } from '@shared/project'
import { interpolateKeyframes } from '@shared/keyframes'
import { positionScale } from '@shared/clipPosition'
import { clipMotionAt } from '@shared/clipMotion'

const IDENTITY: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }

export interface ClipScreenRect {
  /** The clip's own values at this moment (keyframes applied). */
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  /** Where the picture is on the stage now, in stage pixels -- its motion
   * (float, around...) included: the centre, size and turn as drawn. */
  cx: number
  cy: number
  w: number
  h: number
  shownRotation: number
}

/** Where a picture sits in the Player at `currentTime`, as the Player draws
 * it (clipVisuals.ts): fitted to the stage, scaled, moved, turned -- and
 * carried by its motion. The move/size frame is drawn here, and a click on
 * the Player picks the picture under it from this. */
export function clipScreenRect(
  clip: TimelineClip,
  stageSize: { width: number; height: number },
  mediaSize: { width?: number; height?: number } | undefined,
  fit: 'contain' | 'cover',
  currentTime: number
): ClipScreenRect | null {
  const mw = mediaSize?.width
  const mh = mediaSize?.height
  if (!mw || !mh) return null
  const t = clip.transform ?? IDENTITY
  const kf = clip.keyframes
  const timeInClip = currentTime - clip.startTime
  const value = (prop: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'): number => interpolateKeyframes(kf?.[prop], timeInClip, t[prop])
  const x = value('x')
  const y = value('y')
  const scaleX = value('scaleX')
  const scaleY = value('scaleY')
  const rotation = value('rotation')
  const unit = positionScale(stageSize)
  const fitScale = fit === 'cover' ? Math.max(stageSize.width / mw, stageSize.height / mh) : Math.min(stageSize.width / mw, stageSize.height / mh)
  const w = Math.abs(mw * fitScale * scaleX)
  const h = Math.abs(mh * fitScale * scaleY)
  // The same motion the Player plays (clipVisuals.ts measures it on the
  // picture fitted with "contain").
  const containScale = Math.min(stageSize.width / mw, stageSize.height / mh)
  const motion = clip.motion ? clipMotionAt(clip.motion, timeInClip, stageSize, { width: mw * containScale * Math.abs(scaleX), height: mh * containScale * Math.abs(scaleY) }) : null
  return {
    x,
    y,
    scaleX,
    scaleY,
    rotation,
    cx: stageSize.width / 2 + x * unit + (motion?.dx ?? 0),
    cy: stageSize.height / 2 + y * unit + (motion?.dy ?? 0),
    w: w * (motion?.scale ?? 1),
    h: h * (motion?.scale ?? 1),
    shownRotation: rotation + (motion?.rotate ?? 0)
  }
}

/** Whether stage point (px, py) is on the picture (its turn included). */
export function isOnClip(rect: ClipScreenRect, px: number, py: number): boolean {
  const a = (-rect.shownRotation * Math.PI) / 180
  const dx = px - rect.cx
  const dy = py - rect.cy
  const lx = dx * Math.cos(a) - dy * Math.sin(a)
  const ly = dx * Math.sin(a) + dy * Math.cos(a)
  return Math.abs(lx) <= rect.w / 2 && Math.abs(ly) <= rect.h / 2
}
