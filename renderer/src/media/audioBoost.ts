/** Clip volume above 100% in the Player. An <audio>/<video> element's own
 * `volume` stops at 1, so louder than the source needs a Web Audio gain
 * stage. An element is routed through one only the first time it is asked
 * for more than 100% (from then on it stays routed -- an element can be
 * connected to a MediaElementSource only once); everything else plays
 * exactly as before. The media protocol sends CORS headers and the
 * elements are crossOrigin="anonymous", without which the routed sound
 * would come out silent. Export applies the same gain with ffmpeg's
 * `volume` filter. */
let context: AudioContext | null = null
const gains = new WeakMap<HTMLMediaElement, GainNode>()

/** The highest clip volume the app offers (Clip Properties > Volume). */
export const MAX_CLIP_VOLUME = 3

/** Sets an element's loudness: `level` 0..MAX_CLIP_VOLUME (1 = as recorded). */
export function setElementLevel(el: HTMLMediaElement, level: number): void {
  const safe = Math.max(0, Math.min(MAX_CLIP_VOLUME, Number.isFinite(level) ? level : 1))
  el.volume = Math.min(1, safe)
  let gain = gains.get(el)
  if (!gain) {
    if (safe <= 1) return
    try {
      context ??= new AudioContext()
      const source = context.createMediaElementSource(el)
      gain = context.createGain()
      source.connect(gain).connect(context.destination)
      gains.set(el, gain)
    } catch {
      return // stays at 100% in the Player; Export still applies the gain
    }
  }
  gain.gain.value = Math.max(1, safe)
  if (context?.state === 'suspended') void context.resume()
}
