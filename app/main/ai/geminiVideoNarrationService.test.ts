import { describe, it, expect, vi } from 'vitest'
import type { TranscriptSegment } from '@shared/transcription'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { buildPrompt, narrationNeedsLanguageRepair } = await import('./geminiVideoNarrationService')

const segments: TranscriptSegment[] = [
  { id: 's1', startTime: 10, endTime: 12, text: 'Brother, be careful!' } as TranscriptSegment
]

function prompt(overrides: Partial<Parameters<typeof buildPrompt>[0]> = {}): string {
  return buildPrompt({ startTime: 0, endTime: 90, segments, characterContext: '', ...overrides })
}

describe('buildPrompt', () => {
  it('uses one recap form for any story without assuming a genre', () => {
    const text = prompt()
    expect(text).toContain('STORY-AGNOSTIC MODE')
    expect(text).toContain('any story, country, language, period, or genre')
    expect(text).toContain('Begin every new source video with an empty story model.')
    expect(text).toContain('the RECAP FORM stays fixed')
    expect(text).toContain('Never assume that a visual trope has the same meaning across stories.')
  })

  it('demands every gesture with its owner, target and concrete verb', () => {
    const text = prompt()
    expect(text).toContain('GESTURE COVERAGE')
    expect(text).toContain('Leaving a gesture out is as bad as inventing one.')
    expect(text).toContain('WHO -> EXACT ACTION -> ON WHOM/WHAT')
    expect(text).toContain('ខ្ទប់មាត់')
    // A fight must not be flattened into a single sentence.
    expect(text).toContain('Each strike, block, fall, stand-up, dodge')
  })

  it('uses a story-neutral style blueprint without injecting the old example story', () => {
    const text = prompt()
    expect(text).toContain('STYLE BLUEPRINT')
    expect(text).toContain('Every name, relationship, place, object, power, rank, action, purpose, and event must come exclusively from THIS video')
    expect(text).toContain('Never copy a name, character, place, object, or plot event from an example, a previous project, or another story.')
    expect(text).not.toContain('គូ អាន')
    expect(text).not.toContain('ស៊ាវ នីង')
  })

  it('asks for one short paragraph per scene and a cut line only on a real cut', () => {
    const text = prompt()
    expect(text).toContain('usually one to three sentences')
    expect(text).toContain('សាច់រឿងកាត់មកកន្លែងមួយទៀត។')
    expect(text).toContain('Do not use them between two shots of the same scene.')
  })

  it('treats a visible reaction as an observation, not a guess', () => {
    const text = prompt()
    expect(text).toContain('IS such an observation')
    expect(text).toContain('never a hidden thought, plan, or feeling')
  })

  it('greets the viewer on the first chunk only', () => {
    expect(prompt({ firstChunk: true })).toContain('a short greeting to the viewers')
    expect(prompt({ firstChunk: false })).toContain('Do not add another greeting')
    expect(prompt({ firstChunk: true, regeneration: true })).not.toContain('a short greeting to the viewers')
  })

  it('budgets enough scenes for one paragraph per beat', () => {
    expect(prompt()).toContain('at most 15 meaningful scenes')
    expect(prompt({ startTime: 0, endTime: 12 })).toContain('at most 6 meaningful scenes')
  })

  it('locks a confirmed person to one canonical name across chunks', () => {
    const text = prompt({ identityLocks: [{ canonicalName: 'Gu An', aliases: ['Brother An', 'An'], visualIdentity: 'one-armed man' }] })
    expect(text).toContain('LANGUAGE AND CANONICAL-NAME LOCK')
    expect(text).toContain('use that exact locked name')
    expect(text).toContain('Never revert to clothing, hair, colour, age, body, or appearance labels')
    expect(text).toContain('"canonicalName":"Gu An"')
  })

  it('detects foreign dialogue leakage without rejecting a Romanized proper name', () => {
    expect(narrationNeedsLanguageRepair('谷安哥 (Brother Gu An)')).toBe(true)
    expect(narrationNeedsLanguageRepair('Then I can only do this')).toBe(true)
    expect(narrationNeedsLanguageRepair('Gu An')).toBe(false)
  })

  it('supplies whole-story SRT so later facts can resolve an earlier action without moving future events', () => {
    const text = prompt({
      startTime: 0,
      endTime: 90,
      segments: [
        { id: 'early', startTime: 12, endTime: 14, text: 'A man cuts a watermelon.' } as TranscriptSegment,
        { id: 'later', startTime: 180, endTime: 183, text: 'Gu An is Xiao Ning\'s older brother.' } as TranscriptSegment
      ]
    })
    expect(text).toContain('WHOLE-STORY CONTEXT AND CAUSAL RETELLING')
    expect(text).toContain('CONFIRMED CHARACTER + CURRENT ACTION + CONFIRMED PURPOSE + BENEFICIARY')
    expect(text).not.toContain('kite')
    expect(text).toContain('[FULL-SRT-2 | 180.000-183.000s] Gu An is Xiao Ning\'s older brother.')
    expect(text).toContain('Do not reveal a future twist')
  })

  it('forbids semantic double-telling across adjacent scenes', () => {
    const text = prompt({ previousNarration: 'Gu An climbs while the children cheer.' })
    expect(text).toContain('NO DOUBLE-TELLING ACROSS SCENES')
    expect(text).toContain('Two differently worded sentences that describe the same event are still duplicates.')
    expect(text).toContain('Each action, shouted line, explanation, relationship, and plot fact must be narrated exactly once')
  })

  it('keeps inner speech with its character and locks immortal terminology', () => {
    const text = prompt()
    expect(text).toContain('SPEAKER, INNER-VOICE, AND TERMINOLOGY FIDELITY')
    expect(text).toContain("a confirmed character's private thought or inner voice")
    expect(text).toContain('“Immortal” must be translated as “អមតៈ”')
    expect(text).toContain('“ទេព” only when the source actually says deity/god')
    expect(text).toContain('never introduce an unsupported “អ្នកនិទានរឿង”')
  })
})
