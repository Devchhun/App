import { describe, it, expect } from 'vitest'
import { parseFfmpegProgressPercent } from './ffmpegProgress'

describe('parseFfmpegProgressPercent', () => {
  it('returns null when no out_time_ms line is present', () => {
    expect(parseFfmpegProgressPercent(['frame=10', 'fps=30'], 100)).toBeNull()
  })

  it('computes percent from a single out_time_ms line', () => {
    expect(parseFfmpegProgressPercent(['out_time_ms=50000000'], 100)).toBeCloseTo(50)
  })

  it('uses the LAST out_time_ms line when several are present in one batch', () => {
    const lines = ['out_time_ms=10000000', 'frame=5', 'out_time_ms=90000000']
    expect(parseFfmpegProgressPercent(lines, 100)).toBeCloseTo(90)
  })

  it('clamps to 100 when out_time exceeds the known total duration', () => {
    expect(parseFfmpegProgressPercent(['out_time_ms=999000000'], 100)).toBe(100)
  })

  it('returns null for a malformed out_time_ms value instead of NaN', () => {
    expect(parseFfmpegProgressPercent(['out_time_ms=notanumber'], 100)).toBeNull()
  })
})
