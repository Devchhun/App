import { describe, it, expect } from 'vitest'
import { buildNarrationFilterGraph } from './narrationAudio'
import { createDefaultNarrationOptimizationSettings } from '@shared/narration'

describe('buildNarrationFilterGraph', () => {
  it('returns null when every setting is off', () => {
    const settings = { trimSilence: false, fadeInOut: false, noiseReduction: false, loudnessNormalize: false, autoGain: false }
    expect(buildNarrationFilterGraph(settings)).toBeNull()
  })

  it('includes only the enabled steps, in a fixed order regardless of input order', () => {
    const graph = buildNarrationFilterGraph({ trimSilence: false, fadeInOut: true, noiseReduction: true, loudnessNormalize: false, autoGain: false })
    expect(graph).not.toBeNull()
    const steps = graph!.split(',')
    // afftdn (noise reduction) must come before the fade steps regardless of
    // the settings object's own key order.
    expect(steps.indexOf('afftdn')).toBeLessThan(steps.findIndex((s) => s.startsWith('afade')))
  })

  it('defaults (trimSilence + fadeInOut only) produce a graph containing exactly those two steps', () => {
    const graph = buildNarrationFilterGraph(createDefaultNarrationOptimizationSettings())
    expect(graph).toContain('silenceremove')
    expect(graph).toContain('afade')
    expect(graph).not.toContain('afftdn')
    expect(graph).not.toContain('dynaudnorm')
    expect(graph).not.toContain('loudnorm')
  })

  it('enables every step when every setting is on', () => {
    const graph = buildNarrationFilterGraph({ trimSilence: true, fadeInOut: true, noiseReduction: true, loudnessNormalize: true, autoGain: true })
    expect(graph).toContain('silenceremove')
    expect(graph).toContain('afftdn')
    expect(graph).toContain('dynaudnorm')
    expect(graph).toContain('loudnorm')
    expect(graph).toContain('afade')
  })

  it('never alters pitch or speed -- no atempo/asetrate/rubberband filter is ever emitted', () => {
    const graph = buildNarrationFilterGraph({ trimSilence: true, fadeInOut: true, noiseReduction: true, loudnessNormalize: true, autoGain: true })
    expect(graph).not.toMatch(/atempo|asetrate|rubberband/)
  })
})
