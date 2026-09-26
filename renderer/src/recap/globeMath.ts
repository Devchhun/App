/** Geometry for the spinning Earth on the Recap button (EarthGlobe.tsx).
 * Every pixel of the disc is worked out once -- where on the world map it
 * looks, how much sunlight falls on it, how much atmosphere haze it gets --
 * so drawing a frame is only a texture lookup per pixel with the map
 * slid sideways by the current rotation. */

export interface GlobeSamples {
  size: number
  /** Pixel index (y * size + x) of each sample. */
  index: Int32Array
  /** Map position before rotation: u in turns (0..1), v in 0..1 from the north pole. */
  u: Float32Array
  v: Float32Array
  /** Sunlight multiplier (night side dim, not black). */
  light: Float32Array
  /** 0..1 blend toward the atmosphere's blue, strongest at the rim. */
  haze: Float32Array
  /** 0..1 coverage for the anti-aliased edge. */
  alpha: Float32Array
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const smoothstep = (a: number, b: number, value: number): number => {
  const t = clamp01((value - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** `tiltDeg` leans the axis sideways like Earth's 23.4°; `towardDeg` tips
 * the north pole a little toward the viewer so it reads as a ball. */
export function buildGlobeSamples(size: number, tiltDeg = 23.4, towardDeg = 16): GlobeSamples {
  const tilt = (tiltDeg * Math.PI) / 180
  const toward = (towardDeg * Math.PI) / 180
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt)
  const cosW = Math.cos(toward), sinW = Math.sin(toward)
  // Sun mostly from the front (a little up and left): at button size a
  // half-dark globe just read as a dim blur.
  const sunLength = Math.hypot(-0.35, 0.3, 0.9)
  const sun = [-0.35 / sunLength, 0.3 / sunLength, 0.9 / sunLength]
  const index: number[] = [], u: number[] = [], v: number[] = [], light: number[] = [], haze: number[] = [], alpha: number[] = []
  const half = size / 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let x = (px + 0.5 - half) / half
      let y = (half - (py + 0.5)) / half
      const r = Math.hypot(x, y)
      const coverage = clamp01((1 - r) * half + 0.5)
      if (coverage <= 0) continue
      if (r > 0.999) { x *= 0.999 / r; y *= 0.999 / r }
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
      // Screen -> globe: undo the sideways tilt, then the tip toward us.
      const x1 = x * cosT + y * sinT
      const y1 = -x * sinT + y * cosT
      const y2 = y1 * cosW - z * sinW
      const z2 = y1 * sinW + z * cosW
      const lat = Math.asin(Math.max(-1, Math.min(1, y2)))
      const lon = Math.atan2(x1, z2)
      const facing = x * sun[0] + y * sun[1] + z * sun[2]
      index.push(py * size + px)
      u.push(lon / (2 * Math.PI) + 0.5)
      v.push(clamp01(0.5 - lat / Math.PI))
      light.push((0.35 + 1.0 * smoothstep(-0.2, 0.55, facing)) * (0.86 + 0.14 * z))
      haze.push(Math.pow(1 - z, 3) * 0.6)
      alpha.push(coverage)
    }
  }
  return {
    size,
    index: Int32Array.from(index),
    u: Float32Array.from(u),
    v: Float32Array.from(v),
    light: Float32Array.from(light),
    haze: Float32Array.from(haze),
    alpha: Float32Array.from(alpha)
  }
}

/** Paints one frame into `out` (RGBA, size x size). `turn` is the rotation
 * in turns; the map slides so the surface moves west to east. */
export function paintGlobe(samples: GlobeSamples, texture: { width: number; height: number; data: Uint8ClampedArray }, turn: number, out: Uint8ClampedArray): void {
  const { width, height, data } = texture
  const hazeR = 120, hazeG = 180, hazeB = 255
  for (let i = 0; i < samples.index.length; i++) {
    let u = samples.u[i] - turn
    u -= Math.floor(u)
    // Bilinear: the four nearest texels blended (the nearest one alone
    // looked blocky and smeared at button size).
    const fx = u * width - 0.5
    const fy = Math.max(0, Math.min(height - 1, samples.v[i] * height - 0.5))
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const ax = fx - x0, ay = fy - y0
    const xa = ((x0 % width) + width) % width, xb = (xa + 1) % width
    const ya = y0, yb = Math.min(height - 1, y0 + 1)
    const t00 = (ya * width + xa) * 4, t10 = (ya * width + xb) * 4, t01 = (yb * width + xa) * 4, t11 = (yb * width + xb) * 4
    const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay
    const r = data[t00] * w00 + data[t10] * w10 + data[t01] * w01 + data[t11] * w11
    const g = data[t00 + 1] * w00 + data[t10 + 1] * w10 + data[t01 + 1] * w01 + data[t11 + 1] * w11
    const b = data[t00 + 2] * w00 + data[t10 + 2] * w10 + data[t01 + 2] * w01 + data[t11 + 2] * w11
    const light = samples.light[i]
    const haze = samples.haze[i]
    const o = samples.index[i] * 4
    out[o] = r * light * (1 - haze) + hazeR * haze
    out[o + 1] = g * light * (1 - haze) + hazeG * haze
    out[o + 2] = b * light * (1 - haze) + hazeB * haze
    out[o + 3] = samples.alpha[i] * 255
  }
}
