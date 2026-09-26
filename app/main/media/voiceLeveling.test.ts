import { describe, it, expect } from 'vitest'
import { buildVoiceShapeFilterGraph, buildVoiceLevelFilterGraph, REFERENCE_LEVEL, NARRATION_LEVEL } from './voiceLeveling'

describe('buildVoiceShapeFilterGraph', () => {
  it('cleans and trims both edges of a reference clip but never compresses it', () => {
    // A compressed reference clones as a tighter, flatter voice than the
    // person has -- the reference gets linear gain and a ceiling only.
    const graph = buildVoiceShapeFilterGraph(REFERENCE_LEVEL)
    expect(graph.startsWith('highpass=f=70,')).toBe(true)
    expect(graph.match(/silenceremove/g)).toHaveLength(2)
    expect(graph).not.toContain('acompressor')
  })

  it('keeps the edges and the dynamics of a finished narration', () => {
    const graph = buildVoiceShapeFilterGraph(NARRATION_LEVEL)
    expect(graph).not.toContain('silenceremove')
    expect(graph).not.toContain('acompressor')
  })

  it('compresses only when asked', () => {
    expect(buildVoiceShapeFilterGraph({ trimEdges: false, compress: true })).toContain('acompressor=threshold=-22dB:ratio=3:attack=10:release=150:knee=4')
  })
})

describe('buildVoiceLevelFilterGraph', () => {
  it('applies the measured gain then holds peaks at the ceiling', () => {
    expect(buildVoiceLevelFilterGraph(-4.2, -3)).toBe('volume=-4.2dB,alimiter=limit=0.7079:attack=3:release=40:level=false')
  })
})

describe('level presets', () => {
  it('puts a reference a little under dialogue level with a firmer ceiling', () => {
    expect(REFERENCE_LEVEL.targetLufs).toBeLessThan(NARRATION_LEVEL.targetLufs)
    expect(REFERENCE_LEVEL.ceilingDb).toBeLessThan(NARRATION_LEVEL.ceilingDb)
    expect(REFERENCE_LEVEL.trimEdges).toBe(true)
  })
})
