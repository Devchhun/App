import { describe, expect, it } from 'vitest'
import { adjustCssFilter, adjustFfmpegSteps, backgroundBlurSigma, isNeutralAdjust, saturateHueMatrix } from './clipAdjust'
import { buildExportFilterGraph, DEFAULT_EXPORT_OPTIONS } from './export'
import type { TimelineClip } from './project'

describe('clip adjustment', () => {
  it('does nothing at zero', () => {
    expect(isNeutralAdjust(undefined)).toBe(true)
    expect(isNeutralAdjust({ brightness: 0, hue: 0 })).toBe(true)
    expect(adjustCssFilter({})).toBeUndefined()
    expect(adjustFfmpegSteps({ contrast: 0 })).toEqual([])
  })

  it('gives the Player a CSS filter and Export the same formulas', () => {
    expect(adjustCssFilter({ brightness: 20, contrast: -10, saturation: 50, hue: 50 })).toBe('brightness(1.2) contrast(0.9) saturate(1.5) hue-rotate(90deg)')
    const steps = adjustFfmpegSteps({ brightness: 20, saturation: -100 })
    expect(steps[0]).toMatch(/^lutrgb=r='clip\(\(clip\(val\*1\.2,0,255\)-127\.5\)\*1\+127\.5,0,255\)'/)
    expect(steps[1]).toMatch(/^colorchannelmixer=rr=0\.213:rg=0\.715:rb=0\.072/)
    // No hue and full saturation: the identity.
    const id = saturateHueMatrix(1, 0)
    expect(id.map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('blurs by a share of the frame height, so Player and Export look alike', () => {
    expect(backgroundBlurSigma(50, 1080)).toBeCloseTo(36.72, 2)
    expect(backgroundBlurSigma(50, 360) / 360).toBeCloseTo(backgroundBlurSigma(50, 1080) / 1080, 9)
  })
})

describe('export with Background > Blur', () => {
  const clip = (patch: Partial<TimelineClip>): TimelineClip => ({ id: 'v', mediaId: 'm', type: 'video', trackId: 'V1', startTime: 0, duration: 2, sourceIn: 0, sourceOut: 2, locked: false, ...patch })
  const graph = (patch: Partial<TimelineClip>, gpu = false): { graph: string; args: string[] } => {
    const rc = { clip: clip(patch), sourcePath: 'film.mp4', trackOrder: 0 }
    const { args } = buildExportFilterGraph([rc], [], 2, { width: 720, height: 1280 }, 30, { ...DEFAULT_EXPORT_OPTIONS, includeAudio: false }, 'out.mp4', undefined, { seekInputs: true, gpuDecode: gpu })
    return { graph: args[args.indexOf('-filter_complex') + 1], args }
  }

  it('fills the frame with the clip enlarged and blurred, under the clip as placed', () => {
    const { graph: g } = graph({ backgroundBlur: 50, adjust: { saturation: -50 }, transform: { x: 0, y: 0, scaleX: -1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 } })
    expect(g).toContain('split=2[fgs0][bgs0]')
    expect(g).toMatch(/\[bgs0\]scale=180:320:force_original_aspect_ratio=increase,crop=180:320,hflip,colorchannelmixer=[^,]+,gblur=sigma=[\d.]+,scale=720:1280/)
    expect(g).toContain('[bg0][c0]overlay=')
  })

  it('decodes a blurred-background clip on the CPU, others still on the GPU', () => {
    expect(graph({ backgroundBlur: 50 }, true).args.join(' ')).not.toContain('-hwaccel')
    expect(graph({}, true).args.join(' ')).toContain('-hwaccel cuda')
  })
})
