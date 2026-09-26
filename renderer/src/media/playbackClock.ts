/** Decides, once per animation frame, where the playhead goes next.
 *
 * The playhead used to run purely on the wall clock and the <video> element
 * chased it, seeking whenever it fell 0.3 s behind. A seek makes the decoder
 * restart from the previous keyframe, which on long-GOP files (phone/TikTok
 * video, a source still being proxied) takes longer than 0.3 s -- so by the
 * time the frame arrived the video was behind again and got seeked again,
 * every half second: measured as 20 seeks and 20 stalls in 15 s, with
 * pictures on screen for only 5 of those seconds.
 *
 * Instead the video is the master clock whenever it is actually playing: the
 * playhead reads the frame the decoder is on, so there is nothing to chase.
 * While the decoder is busy (starting up, seeking, buffering) the playhead
 * WAITS for it, like any editor -- but only briefly. A decoder that never
 * delivers must not freeze the Timeline (the bug the wall clock originally
 * fixed), so after MAX_HOLD_MS the wall clock takes over again. */

export const MAX_HOLD_MS = 1500

export interface PlaybackClockInput {
  /** Playhead time decided on the previous frame. */
  previousTime: number
  /** Wall-clock seconds since the previous frame (already clamped). */
  wallDeltaSeconds: number
  /** The active video's current frame mapped to project time, or null when
   * no video is on screen (a gap, a still image, audio only). */
  videoTime: number | null
  /** True when the element is playing and has data to keep playing. */
  videoReady: boolean
  /** How long the video has gone without advancing. */
  stalledMs: number
}

export type PlaybackClockSource = 'video' | 'hold' | 'wall'

export function nextPlayheadTime(input: PlaybackClockInput): { time: number; source: PlaybackClockSource } {
  const { previousTime, wallDeltaSeconds, videoTime, videoReady, stalledMs } = input
  if (videoTime !== null && videoReady) {
    // Never step backwards: a decoder reporting a hair earlier than last
    // frame would make the playhead jitter.
    return { time: Math.max(previousTime, videoTime), source: 'video' }
  }
  if (videoTime !== null && stalledMs < MAX_HOLD_MS) return { time: previousTime, source: 'hold' }
  return { time: previousTime + wallDeltaSeconds, source: 'wall' }
}

/** HTMLMediaElement.HAVE_FUTURE_DATA: enough is buffered to keep playing. */
const HAVE_FUTURE_DATA = 3

export function isVideoReady(el: Pick<HTMLVideoElement, 'paused' | 'seeking' | 'readyState'>): boolean {
  return !el.paused && !el.seeking && el.readyState >= HAVE_FUTURE_DATA
}
