import { describe, it, expect } from 'vitest'
import { computeMasterGainDb, buildMasterFilterGraph, parseLoudnormJson, parseAstatsRmsDb, DUB_TARGET_LUFS, DUB_TRUE_PEAK_CEILING_DB } from './dubbingMaster'

describe('computeMasterGainDb', () => {
  it('lifts a quiet line and lowers a hot one onto the same target', () => {
    expect(computeMasterGainDb({ integratedLufs: -20.9, truePeakDb: -6 })).toBeCloseTo(2.9, 1)
    expect(computeMasterGainDb({ integratedLufs: -7.6, truePeakDb: 0 })).toBeCloseTo(-10.4, 1)
  })

  it('holds back when the peaks would cross the ceiling before the target is reached', () => {
    // -19 LUFS wants +1 dB, but the peak is already at -2.5 dBTP: only +0.5 fits under -2.
    expect(computeMasterGainDb({ integratedLufs: -19, truePeakDb: -2.5 })).toBe(0.5)
  })

  it('leaves silence and unmeasurable input alone', () => {
    expect(computeMasterGainDb({ integratedLufs: -80, truePeakDb: -60 })).toBe(0)
    expect(computeMasterGainDb({ integratedLufs: NaN, truePeakDb: NaN })).toBe(0)
  })

  it('never applies more than the sane bounds', () => {
    expect(computeMasterGainDb({ integratedLufs: -60, truePeakDb: -50 })).toBe(18)
    expect(computeMasterGainDb({ integratedLufs: 5, truePeakDb: 10 })).toBe(-18)
  })

  it('targets broadcast dialogue level under a safe peak', () => {
    expect(DUB_TARGET_LUFS).toBe(-18)
    expect(DUB_TRUE_PEAK_CEILING_DB).toBeLessThanOrEqual(-1)
  })
})

describe('buildMasterFilterGraph', () => {
  it('trims leading dead air, levels, limits, fades both ends and pads the tail, in that order', () => {
    const graph = buildMasterFilterGraph(2.5)
    const order = ['highpass', 'silenceremove', 'volume=2.5dB', 'alimiter', 'afade=t=in', 'apad', 'areverse', 'afade=t=in', 'areverse']
    let last = -1
    for (const step of order) {
      const at = graph.indexOf(step, last + 1)
      expect(at, step).toBeGreaterThan(last)
      last = at
    }
  })

  it('expresses the peak ceiling to the limiter as a linear amplitude', () => {
    expect(buildMasterFilterGraph(0, -2)).toContain('alimiter=limit=0.7943')
  })
})

describe('parseLoudnormJson', () => {
  it("reads ffmpeg's loudnorm summary out of the surrounding log noise", () => {
    const stderr = 'Input #0 ...\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-12.34",\n\t"input_tp" : "0.20",\n\t"input_lra" : "0.00"\n}\n'
    expect(parseLoudnormJson(stderr)).toEqual({ integratedLufs: -12.34, truePeakDb: 0.2 })
    expect(parseLoudnormJson('nothing here')).toBeNull()
  })
})

describe('loudness of a line too short for loudnorm', () => {
  it("reads the overall RMS level from ffmpeg's astats", () => {
    const stderr = ['[Parsed_astats_0 @ 0] Channel: 1', '[Parsed_astats_0 @ 0] RMS level dB: -30.5', '[Parsed_astats_0 @ 0] Overall', '[Parsed_astats_0 @ 0] RMS level dB: -25.2'].join('\n')
    expect(parseAstatsRmsDb(stderr)).toBe(-25.2)
  })
  it('gives nothing for silence or no output', () => {
    expect(parseAstatsRmsDb('Overall\nRMS level dB: -inf')).toBeNull()
    expect(parseAstatsRmsDb('')).toBeNull()
  })
  it('the trailing silence is trimmed too, keeping a little tail', () => {
    const graph = buildMasterFilterGraph(0)
    expect(graph).toContain('areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse')
  })
})
