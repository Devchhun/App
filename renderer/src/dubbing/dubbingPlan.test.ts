import { describe, expect, it } from 'vitest'
import { AUTO_SPEED_MAX, KIRI_FALLBACK_FEMALE, assignTwoVoices, withHeardGenders, autoSpeedFor, joinSpokenLines, JOIN_MAX_GAP_SECONDS, planAutoSync, planGenerationUnits, resolveLineVoice, voiceUsage, type PlannedLine } from './dubbingPlan'
import { defaultDubbingSegmentState, type DubbingSegmentState } from '@shared/dubbing'
import { kiriVoiceId } from '@shared/kiriTts'

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
  it('keeps a line said by several voices together as a take of its own', () => {
    const units = planGenerationUnits([line('a', 0, 2), line('b', 2.2, 4, 'female-adult', 'yes', { together: ['male-adult'] }), line('c', 4.2, 6)])
    expect(units.map((u) => [u.leaderId, u.memberIds, u.together])).toEqual([['a', [], undefined], ['b', [], ['male-adult']], ['c', [], undefined]])
  })

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

describe('voiceUsage', () => {
  const l = (id: string, voiceId: string | undefined, detectedGender: 'male' | 'female' | 'unknown' = 'unknown') => ({ id, state: { voiceId, detectedGender }, speaker: undefined })

  it('counts the lines of each voice, the most used first, lines in script order', () => {
    const usage = voiceUsage([l('1', 'male-old'), l('2', 'female-adult'), l('3', 'male-old'), l('4', 'male-old'), l('5', 'female-adult'), l('6', 'khmer-young')], 'voxcpm2')
    expect(usage.map((u) => [u.voiceId, u.segmentIds])).toEqual([
      ['male-old', ['1', '3', '4']],
      ['female-adult', ['2', '5']],
      ['khmer-young', ['6']]
    ])
  })

  it('counts a line with no voice of its own under the voice its gender gets', () => {
    const usage = voiceUsage([l('1', undefined, 'female'), l('2', 'female-adult'), l('3', undefined, 'male')], 'voxcpm2')
    expect(usage.map((u) => [u.voiceId, u.segmentIds.length])).toEqual([
      ['female-adult', 2],
      ['male-adult', 1]
    ])
  })

  it('groups by what the engine will really speak (Edge has two voices)', () => {
    const usage = voiceUsage([l('1', 'kiri:a', 'female'), l('2', 'kiri:b', 'female'), l('3', 'kiri:c', 'male')], 'edge-tts')
    expect(usage.map((u) => [u.voiceId, u.segmentIds])).toEqual([
      ['khmer-female', ['1', '2']],
      ['khmer-narrator', ['3']]
    ])
  })
})

describe('assignTwoVoices', () => {
  const fresh = (id: string) => defaultDubbingSegmentState(id)
  const state = (id: string, patch: Partial<DubbingSegmentState>): DubbingSegmentState => ({ ...fresh(id), ...patch })
  const voices = { male: kiriVoiceId('man-voice'), female: kiriVoiceId('woman-voice') }

  it('gives each line the man\'s or the woman\'s voice by gender alone, whatever its age', () => {
    const states = {
      a: state('a', { ageGroup: 'old', detectedGender: 'unknown' }),
      b: state('b', { ageGroup: 'child', detectedGender: 'male' }),
      c: state('c', { ageGroup: 'young', voiceId: 'kiri:someone-else', voiceManuallyAssigned: true, status: 'generated' }),
      d: state('d', { status: 'generating' })
    }
    const heard = { a: { gender: 'female' as const, confidence: 0.9 }, b: { gender: 'female' as const, confidence: 0.8 }, c: { gender: 'male' as const, confidence: 0.7 }, d: { gender: 'unknown' as const, confidence: 0 } }
    const { segments, counts } = assignTwoVoices(['a', 'b', 'c', 'd', 'e'], states, heard, voices, fresh)
    expect(segments.a.voiceId).toBe(voices.female)
    expect(segments.a.detectedGender).toBe('female')
    expect(segments.a.ageGroup).toBe('old')
    // What was just heard wins over an older guess.
    expect(segments.b.voiceId).toBe(voices.female)
    expect(segments.c.voiceId).toBe(voices.male)
    expect(segments.c.status).toBe('voice-assigned')
    // Not heard and not known: the man's voice, counted as unknown; a line being generated keeps its status.
    expect(segments.d.voiceId).toBe(voices.male)
    expect(segments.d.status).toBe('generating')
    expect(segments.e.voiceId).toBe(voices.male)
    expect(counts).toEqual({ male: 1, female: 2, unknown: 2, child: 0, old: 0 })
    expect(Object.values(segments).every((s) => s.voiceManuallyAssigned)).toBe(true)
  })

  it('keeps the gender a line already had when nothing new was heard', () => {
    const { segments, counts } = assignTwoVoices(['a', 'b'], { a: state('a', { detectedGender: 'female' }), b: state('b', { detectedGender: 'male' }) }, null, voices, fresh)
    expect(segments.a.voiceId).toBe(voices.female)
    expect(segments.b.voiceId).toBe(voices.male)
    expect(counts).toEqual({ male: 1, female: 1, unknown: 0, child: 0, old: 0 })
  })

  it('is the voice Generate speaks the line in, on KiriTTS (age never swaps it)', () => {
    const { segments } = assignTwoVoices(['a', 'b'], { a: state('a', { ageGroup: 'old' }), b: state('b', { ageGroup: 'child' }) }, { a: { gender: 'female', confidence: 0.9 }, b: { gender: 'male', confidence: 0.9 } }, voices, fresh)
    expect(resolveLineVoice(segments.a, undefined, 'kiritts').voiceId).toBe(voices.female)
    expect(resolveLineVoice(segments.b, undefined, 'kiritts').voiceId).toBe(voices.male)
  })
})

describe('withHeardGenders', () => {
  const fresh = (id: string) => defaultDubbingSegmentState(id)

  it('writes the heard gender onto lines that have none, and changes no voice', () => {
    const states = {
      a: { ...fresh('a'), voiceId: 'kiri:chosen', voiceManuallyAssigned: true },
      b: { ...fresh('b'), detectedGender: 'female' as const }
    }
    const heard = { a: { gender: 'female' as const, confidence: 0.9 }, b: { gender: 'male' as const, confidence: 0.9 }, c: { gender: 'male' as const, confidence: 0.7 }, d: { gender: 'unknown' as const, confidence: 0 } }
    const got = withHeardGenders(['a', 'b', 'c', 'd'], states, heard, fresh)!
    expect(got.a.detectedGender).toBe('female')
    expect(got.a.voiceId).toBe('kiri:chosen')
    // A gender already there (by hand, or heard before) is kept.
    expect(got.b).toBeUndefined()
    expect(got.c.detectedGender).toBe('male')
    expect(got.c.voiceId).toBeUndefined()
    expect(got.d).toBeUndefined()
  })

  it('is null when nothing changes', () => {
    expect(withHeardGenders(['a'], { a: { ...fresh('a'), detectedGender: 'male' } }, { a: { gender: 'female', confidence: 1 } }, fresh)).toBeNull()
    expect(withHeardGenders(['a'], {}, {}, fresh)).toBeNull()
  })
})

describe('resolveLineVoice with the story\'s two voices', () => {
  const story = { male: kiriVoiceId('Kattt'), female: kiriVoiceId('តួស្រី') }
  const line = (patch: Partial<DubbingSegmentState>): DubbingSegmentState => ({ ...defaultDubbingSegmentState('x'), ...patch })

  it('speaks a line with no voice of its own in the man\'s or the woman\'s voice picked for the story', () => {
    expect(resolveLineVoice(line({ detectedGender: 'female' }), undefined, 'kiritts', undefined, story).voiceId).toBe(story.female)
    expect(resolveLineVoice(line({ detectedGender: 'male' }), undefined, 'kiritts', undefined, story).voiceId).toBe(story.male)
    // Not known: the man's, as Use for all does.
    expect(resolveLineVoice(line({}), undefined, 'kiritts', undefined, story).voiceId).toBe(story.male)
  })

  it('never overrides a voice picked for the line, and without picks falls back as before', () => {
    expect(resolveLineVoice(line({ detectedGender: 'female', voiceId: kiriVoiceId('Nita') }), undefined, 'kiritts', undefined, story).voiceId).toBe(kiriVoiceId('Nita'))
    expect(resolveLineVoice(line({ detectedGender: 'female' }), undefined, 'kiritts').voiceId).toBe(kiriVoiceId(KIRI_FALLBACK_FEMALE))
  })
})

describe('story voices by gender and age', () => {
  const v = { male: 'kiri:Kattt', female: 'kiri:តួស្រី', child: 'kiri:ក្មេងតូច', oldMale: 'kiri:តួប្រុសចាស់', oldFemale: 'kiri:តួស្រីចាស់' }
  const fresh = (id: string) => defaultDubbingSegmentState(id)
  const st = (id: string, patch: Partial<DubbingSegmentState>): DubbingSegmentState => ({ ...fresh(id), ...patch })

  it('gives children, old men and old women their voices; everyone else by gender', () => {
    const states = {
      kid: st('kid', { detectedGender: 'male', ageGroup: 'child' }),
      grandpa: st('grandpa', { detectedGender: 'male', ageGroup: 'elder' }),
      grandma: st('grandma', { detectedGender: 'female', ageGroup: 'old' }),
      man: st('man', { detectedGender: 'male' }),
      woman: st('woman', { detectedGender: 'female', ageGroup: 'adult' })
    }
    const { segments, counts } = assignTwoVoices(Object.keys(states), states, null, v, fresh)
    expect(segments.kid.voiceId).toBe(v.child)
    expect(segments.grandpa.voiceId).toBe(v.oldMale)
    expect(segments.grandma.voiceId).toBe(v.oldFemale)
    expect(segments.man.voiceId).toBe(v.male)
    expect(segments.woman.voiceId).toBe(v.female)
    expect(counts).toMatchObject({ male: 3, female: 2, child: 1, old: 2 })
  })

  it('falls back to the man\'s or the woman\'s voice when no child / old voice is picked', () => {
    const states = { kid: st('kid', { detectedGender: 'female', ageGroup: 'child' }), grandpa: st('grandpa', { detectedGender: 'male', ageGroup: 'elder' }) }
    const { segments, counts } = assignTwoVoices(['kid', 'grandpa'], states, null, { male: v.male, female: v.female }, fresh)
    expect(segments.kid.voiceId).toBe(v.female)
    expect(segments.grandpa.voiceId).toBe(v.male)
    expect(counts).toMatchObject({ child: 0, old: 0 })
  })

  it('is the voice Generate uses for a line with none of its own, by its character\'s age', () => {
    const line = st('x', { detectedGender: 'female' })
    expect(resolveLineVoice(line, { gender: 'female', ageCategory: 'elder' }, 'kiritts', undefined, v).voiceId).toBe(v.oldFemale)
    expect(resolveLineVoice({ ...line, ageGroup: 'child' }, undefined, 'kiritts', undefined, v).voiceId).toBe(v.child)
  })
})
