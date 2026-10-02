import { describe, expect, it } from 'vitest'
import { AUTO_SPEED_MAX, autoSpeedFor, joinSpokenLines, JOIN_MAX_GAP_SECONDS, planAutoSync, planGenerationUnits, resolveLineVoice, type PlannedLine } from './dubbingPlan'

describe('resolveLineVoice', () => {
  it('a KiriTTS voice made with another engine becomes that engine voice of the same gender, not Male Adult', () => {
    const kiriLine = { voiceId: 'kiri:abc123', detectedGender: 'female' as const }
    expect(resolveLineVoice(kiriLine, undefined, 'voxcpm2').voiceId).toBe('female-adult')
    expect(resolveLineVoice(kiriLine, undefined, 'edge-tts').voiceId).toBe('khmer-female')
    expect(resolveLineVoice(kiriLine, undefined, 'kiritts').voiceId).toBe('kiri:abc123')
  })
  const unknownLine = { voiceId: undefined, detectedGender: 'unknown' as const }

  it("uses the speaker's estimated gender when the line has none (the all-male bug)", () => {
    expect(resolveLineVoice(unknownLine, { gender: 'female', voiceId: undefined }, 'edge-tts').voiceId).toBe('female-adult')
    expect(resolveLineVoice(unknownLine, { gender: 'male', voiceId: undefined }, 'edge-tts').voiceId).toBe('male-adult')
  })

  it('prefers the line pick, then the speaker pick, over any gender guess', () => {
    expect(resolveLineVoice({ voiceId: 'khmer-young', detectedGender: 'male' }, { gender: 'male', voiceId: 'male-old' }, 'edge-tts').voiceId).toBe('khmer-young')
    expect(resolveLineVoice(unknownLine, { gender: 'male', voiceId: 'female-old' }, 'edge-tts').voiceId).toBe('female-old')
  })

  it("prefers the line's own known gender over the speaker's estimate", () => {
    expect(resolveLineVoice({ voiceId: undefined, detectedGender: 'male' }, { gender: 'female', voiceId: undefined }, 'edge-tts').voiceId).toBe('male-adult')
  })

  it('falls back to Male Adult only when nothing is known', () => {
    expect(resolveLineVoice(unknownLine, undefined, 'edge-tts').voiceId).toBe('male-adult')
    expect(resolveLineVoice(unknownLine, { gender: 'unknown', voiceId: undefined }, 'voxcpm2').voiceId).toBe('male-adult')
  })

  it("speaks a cloned voice in Edge's own voice of the speaker's gender", () => {
    expect(resolveLineVoice({ voiceId: 'custom-voice', detectedGender: 'unknown' }, { gender: 'female', voiceId: undefined }, 'edge-tts').voiceId).toBe('khmer-female')
    expect(resolveLineVoice({ voiceId: 'custom-voice', detectedGender: 'unknown' }, { gender: 'female', voiceId: undefined }, 'voxcpm2').voiceId).toBe('custom-voice')
  })
})

const line = (id: string, start: number, end: number, voiceId = 'female-adult', text = `line ${id}`, extra: Partial<PlannedLine> = {}): PlannedLine => ({
  id, text, startTime: start, endTime: end, voiceId, pitch: 0, speed: 1, volumeDb: 0, ...extra
})

describe('planGenerationUnits', () => {
  it('reads neighbouring lines in the same voice as one take', () => {
    const units = planGenerationUnits([line('a', 0, 2), line('b', 2.4, 4), line('c', 4.5, 6)])
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ leaderId: 'a', memberIds: ['b', 'c'], startTime: 0, endTime: 6, voiceId: 'female-adult' })
  })

  it('starts a new take when the voice changes', () => {
    const units = planGenerationUnits([line('a', 0, 2), line('b', 2.2, 4, 'male-adult'), line('c', 4.2, 6)])
    expect(units.map((u) => [u.leaderId, u.memberIds])).toEqual([['a', []], ['b', []], ['c', []]])
  })

  it('starts a new take after a pause longer than the join gap', () => {
    const units = planGenerationUnits([line('a', 0, 2), line('b', 2 + JOIN_MAX_GAP_SECONDS + 0.1, 5)])
    expect(units).toHaveLength(2)
  })

  it('keeps every take within the span limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(`l${i}`, i * 3, i * 3 + 2.8))
    const units = planGenerationUnits(lines)
    for (const unit of units) expect(unit.endTime - unit.startTime).toBeLessThanOrEqual(12)
    expect(units.flatMap((u) => [u.leaderId, ...u.memberIds])).toEqual(lines.map((l) => l.id))
  })

  it('never joins a thought (inner voice) with the spoken line beside it', () => {
    const units = planGenerationUnits([line('a', 0, 2), line('b', 2.2, 4, 'female-adult', 'x', { innerVoice: true }), line('c', 4.2, 6, 'female-adult', 'y', { innerVoice: true })])
    expect(units.map((u) => [u.leaderId, u.memberIds, !!u.innerVoice])).toEqual([['a', [], false], ['b', ['c'], true]])
  })

  it('does not join lines with different pitch, speed or volume', () => {
    const units = planGenerationUnits([line('a', 0, 2), line('b', 2.2, 4, 'female-adult', 'x', { pitch: 2 })])
    expect(units).toHaveLength(2)
  })

  it('can be told not to join at all', () => {
    expect(planGenerationUnits([line('a', 0, 2), line('b', 2.2, 4)], false)).toHaveLength(2)
  })
})

describe('joinSpokenLines', () => {
  it('adds a sentence break between lines that lack one', () => {
    expect(joinSpokenLines(['ចាំខ្ញុំផង', 'ទៅណា?'])).toBe('ចាំខ្ញុំផង។ ទៅណា?')
    expect(joinSpokenLines(['Wait for me', 'Where are you going?'])).toBe('Wait for me. Where are you going?')
  })

  it('keeps punctuation that is already there and never adds one at the end', () => {
    expect(joinSpokenLines(['Stop!', 'Now', 'please'])).toBe('Stop! Now. please')
  })
})

describe('Auto-Speed and Auto-Sync keep the voice clear', () => {
  it('speeds a too-long line up by at most 1.25x, once', () => {
    expect(autoSpeedFor(3, 1, false)).toBe(AUTO_SPEED_MAX)
    expect(autoSpeedFor(1.1, 1, false)).toBe(1.1)
    expect(autoSpeedFor(1.01, 1, false)).toBeNull()
    expect(autoSpeedFor(3, 1, true)).toBeNull()
  })
  it('puts lines back on their subtitles without ever overlapping', () => {
    const moves = planAutoSync([
      { clipId: 'a', subtitleStart: 0, clipStart: 0.4, clipSeconds: 2 },
      { clipId: 'b', subtitleStart: 1, clipStart: 2.5, clipSeconds: 1 },
      { clipId: 'c', subtitleStart: 5, clipStart: 5.3, clipSeconds: 1 }
    ])
    expect(moves).toEqual([
      { clipId: 'a', startTime: 0 },
      // 'b' would start inside 'a' (which runs to 2 s): right after it instead.
      { clipId: 'b', startTime: 2.05 },
      { clipId: 'c', startTime: 5 }
    ])
  })
})

describe('resolveLineVoice with KiriTTS', () => {
  it('keeps a KiriTTS voice; anything else falls back to its Khmer voice of the same gender', () => {
    expect(resolveLineVoice({ voiceId: 'kiri:Lee Chhun', detectedGender: 'male' }, undefined, 'kiritts').voiceId).toBe('kiri:Lee Chhun')
    expect(resolveLineVoice({ voiceId: 'drama-heroine', detectedGender: 'female' }, undefined, 'kiritts').voiceId).toBe('kiri:Nita')
    expect(resolveLineVoice({ voiceId: 'custom-voice', detectedGender: 'unknown' }, { gender: 'male', voiceId: undefined }, 'kiritts').voiceId).toBe('kiri:Chanda')
  })
})

describe('resolveLineVoice with VoxCPM2 voices copied to KiriTTS', () => {
  it('speaks a copied voice as its copy, others by gender', () => {
    const copies: Record<string, string> = { 'drama-heroine': 'Drama Heroine (VoxCPM2)' }
    const copyOf = (id: string): string | undefined => copies[id]
    expect(resolveLineVoice({ voiceId: 'drama-heroine', detectedGender: 'female' }, undefined, 'kiritts', copyOf).voiceId).toBe('kiri:Drama Heroine (VoxCPM2)')
    expect(resolveLineVoice({ voiceId: 'drama-hero', detectedGender: 'male' }, undefined, 'kiritts', copyOf).voiceId).toBe('kiri:Chanda')
    expect(resolveLineVoice({ voiceId: 'drama-heroine', detectedGender: 'female' }, undefined, 'voxcpm2', copyOf).voiceId).toBe('drama-heroine')
  })
})
