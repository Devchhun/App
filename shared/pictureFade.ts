// A picture's fade (TimelineClip.pictureFadeIn / pictureFadeOut): it comes
// in from black -- from see-through, over a track below -- and goes out the
// same way. Between two pictures that both fade, the frame dips to dark for
// a moment instead of cutting hard, as manga recap channels join panels.
// One rule feeds the Player (a number, every frame) and Export (ffmpeg's
// fade filter), so the two dip alike. The clip's own fadeIn/fadeOut are the
// sound's.

import type { TimelineClip } from './project'

type Faded = Pick<TimelineClip, 'duration' | 'pictureFadeIn' | 'pictureFadeOut'>

/** Each fade at most half the clip, so the two never overlap. */
function lengths(clip: Faded): { fadeIn: number; fadeOut: number } {
  const half = Math.max(0, clip.duration) / 2
  const clamp = (v: number | undefined): number => (v && v > 0 ? Math.min(v, half) : 0)
  return { fadeIn: clamp(clip.pictureFadeIn), fadeOut: clamp(clip.pictureFadeOut) }
}

export function hasPictureFade(clip: Faded | undefined): boolean {
  return !!clip && ((clip.pictureFadeIn ?? 0) > 0 || (clip.pictureFadeOut ?? 0) > 0)
}

/** 0-1: how much of the picture shows `t` seconds into the clip. */
export function pictureFadeAt(clip: Faded, t: number): number {
  const { fadeIn, fadeOut } = lengths(clip)
  let level = 1
  if (fadeIn > 0 && t < fadeIn) level = Math.min(level, Math.max(0, t / fadeIn))
  const remaining = clip.duration - t
  if (fadeOut > 0 && remaining < fadeOut) level = Math.min(level, Math.max(0, remaining / fadeOut))
  return level
}

/** ffmpeg steps for a stream whose time 0 is the clip's start: to black,
 * or (`alpha`) to see-through for a picture laid over others. */
export function pictureFadeFfmpegSteps(clip: Faded, alpha: boolean): string[] {
  const { fadeIn, fadeOut } = lengths(clip)
  const tail = alpha ? ':alpha=1' : ''
  const steps: string[] = []
  if (fadeIn > 0) steps.push(`fade=t=in:st=0:d=${round3(fadeIn)}${tail}`)
  if (fadeOut > 0) steps.push(`fade=t=out:st=${round3(clip.duration - fadeOut)}:d=${round3(fadeOut)}${tail}`)
  return alpha && steps.length > 0 ? ['format=yuva420p', ...steps] : steps
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
