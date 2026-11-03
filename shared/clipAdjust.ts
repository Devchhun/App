// Clip Properties > Adjustment (brightness, contrast, saturation, hue) and
// Background > Blur (the frame's empty bars filled with the clip itself,
// enlarged and blurred). One description feeds both the Player (CSS) and
// Export (ffmpeg), with the SAME colour maths: CSS filter functions are
// defined as exact per-pixel formulas on sRGB values (Filter Effects spec),
// and Export runs those formulas -- lutrgb for brightness/contrast, one
// colorchannelmixer matrix for saturation and hue -- so the export looks
// like the Player.

export interface ClipAdjust {
  /** -100..100, 0 = as shot. */
  brightness?: number
  contrast?: number
  saturation?: number
  hue?: number
}

export const ADJUST_FIELDS = ['brightness', 'contrast', 'saturation', 'hue'] as const
export type AdjustField = (typeof ADJUST_FIELDS)[number]

const amount = (v: number | undefined): number => Math.max(-100, Math.min(100, Number.isFinite(v) ? (v as number) : 0))

export function isNeutralAdjust(adjust: ClipAdjust | undefined): boolean {
  return !adjust || ADJUST_FIELDS.every((f) => amount(adjust[f]) === 0)
}

/** The CSS filter factors: brightness/contrast/saturate 0..2, hue in degrees. */
export function adjustFactors(adjust: ClipAdjust | undefined): { brightness: number; contrast: number; saturate: number; hueDeg: number } {
  return {
    brightness: 1 + amount(adjust?.brightness) / 100,
    contrast: 1 + amount(adjust?.contrast) / 100,
    saturate: 1 + amount(adjust?.saturation) / 100,
    hueDeg: amount(adjust?.hue) * 1.8
  }
}

/** For the Player: a CSS `filter`, or undefined when nothing is adjusted. */
export function adjustCssFilter(adjust: ClipAdjust | undefined): string | undefined {
  if (isNeutralAdjust(adjust)) return undefined
  const f = adjustFactors(adjust)
  const parts: string[] = []
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`)
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`)
  if (f.saturate !== 1) parts.push(`saturate(${f.saturate})`)
  if (f.hueDeg !== 0) parts.push(`hue-rotate(${f.hueDeg}deg)`)
  return parts.join(' ')
}

type Matrix = [number, number, number, number, number, number, number, number, number]

function multiply(a: Matrix, b: Matrix): Matrix {
  const m = (r: number, c: number): number => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return [m(0, 0), m(0, 1), m(0, 2), m(1, 0), m(1, 1), m(1, 2), m(2, 0), m(2, 1), m(2, 2)]
}

/** CSS saturate(s) then hue-rotate(deg), as the spec's colour matrices. */
export function saturateHueMatrix(s: number, hueDeg: number): Matrix {
  const sat: Matrix = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]
  const a = (hueDeg * Math.PI) / 180
  const c = Math.cos(a)
  const n = Math.sin(a)
  const hue: Matrix = [
    0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
    0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.14, 0.072 - c * 0.072 - n * 0.283,
    0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072
  ]
  // The pixel goes through saturate first, then hue: hue x sat.
  return multiply(hue, sat)
}

const num = (n: number): string => String(Math.round(n * 1e6) / 1e6)

/** For Export: ffmpeg filter steps giving the Player's colours. */
export function adjustFfmpegSteps(adjust: ClipAdjust | undefined): string[] {
  if (isNeutralAdjust(adjust)) return []
  const f = adjustFactors(adjust)
  const steps: string[] = []
  if (f.brightness !== 1 || f.contrast !== 1) {
    // brightness(b) then contrast(c), each clamped as CSS clamps it.
    const expr = `clip((clip(val*${num(f.brightness)},0,255)-127.5)*${num(f.contrast)}+127.5,0,255)`
    steps.push(`lutrgb=r='${expr}':g='${expr}':b='${expr}'`)
  }
  if (f.saturate !== 1 || f.hueDeg !== 0) {
    const m = saturateHueMatrix(f.saturate, f.hueDeg)
    steps.push(`colorchannelmixer=rr=${num(m[0])}:rg=${num(m[1])}:rb=${num(m[2])}:gr=${num(m[3])}:gg=${num(m[4])}:gb=${num(m[5])}:br=${num(m[6])}:bg=${num(m[7])}:bb=${num(m[8])}`)
  }
  return steps
}

/** Background > Blur strength, 1..100 (0 / undefined = no blur). */
export const DEFAULT_BACKGROUND_BLUR = 50

/** The blur's size as a share of the frame's height, so the Player's small
 * picture and a 1080p export blur alike: a gaussian of this standard
 * deviation (CSS blur(px) and ffmpeg gblur sigma are both that). */
export function backgroundBlurSigma(strength: number, frameHeight: number): number {
  const s = Math.max(1, Math.min(100, strength))
  return frameHeight * (0.004 + 0.0006 * s)
}
